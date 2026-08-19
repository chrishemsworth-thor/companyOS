# Onboarding a new company

Quick runbook for provisioning a client on CompanyOS. Background on the
`/admin/tenants` API and multi-tenant isolation model:
[production-deployment.md](production-deployment.md) §7 and
[architecture/multi-company-identity.md](architecture/multi-company-identity.md).

## 1. Get `PLATFORM_ADMIN_SECRET`

This is a Cloudflare Worker secret — encrypted at rest, not viewable via the
dashboard or `wrangler secret list` once set. If you don't have it saved:

```sh
openssl rand -base64 32              # generate a new value
npx wrangler secret put PLATFORM_ADMIN_SECRET --name companyos-backend
```

Rotating it is low-risk: it only invalidates future `/admin/tenants` calls.
It does not affect existing tenant API keys or operator sessions. Save the
new value in a password manager immediately.

## 2. Create the tenant

```sh
curl -X POST https://api.companyos.com.my/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Client Company Sdn Bhd",
    "slug": "clientco",
    "admin_email": "admin@clientco.com",
    "admin_password": "<a-strong-password>"
  }'
```

This atomically creates the tenant, a fresh API key, and the first admin
user (with the password given, `role: "admin"`). If admin creation fails,
the tenant is rolled back — no orphaned companies.

## 3. Save the API key

The response includes the plaintext API key **exactly once** — only its
SHA-256 hash is stored. Drop it into a password manager before doing
anything else.

## 4. Hand off to the client

- Console: `https://console.companyos.com.my`
- Login: **workspace slug** + admin email + the password you set in step 2

**No welcome email is sent.** `/admin/tenants` creates the first admin with
an active password directly — it does not go through the invite-email flow.
You need to relay the slug/email/password to the client yourself (e.g. a
password manager share, not plaintext chat/email).

The admin lands in the first-run onboarding wizard on first login: company
profile + base currency (required), teams/employees (skippable).

Any *additional* users the client adds afterward (via the console or
`POST /v1/users`) **do** get emailed a single-use invite link — that flow is
separate and only applies past the first admin.

## 5. Optional: seed sample data

Useful for a demo/exploration environment before the client has real data:

```sh
npm run seed:sample -- --api-key <printed_api_key>
```

## 6. Verify

```sh
curl https://api.companyos.com.my/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET"
```

Lists every company currently provisioned on the platform.
