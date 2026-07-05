# Render Deploy Command Log

Commands used from this repo on Windows PowerShell. Secrets are intentionally
redacted.

## Assumptions

- Render CLI binary: `~/OneDrive/Development/render.exe`
- GitHub repo: `https://github.com/Eshan05/MRL-Media`
- Branch: `main`
- Region used: `ohio`
- Workspace: `tea-csp8fkbgbbvc7386fgb0`

## Login and Workspace

You ran login manually:

```powershell
.\render.exe login
```

I set the active workspace:

```powershell
~\OneDrive\Development\render.exe workspace set tea-csp8fkbgbbvc7386fgb0 --output json
```

Useful checks:

```powershell
~\OneDrive\Development\render.exe whoami --output json
~\OneDrive\Development\render.exe workspaces --output json
~\OneDrive\Development\render.exe services --output json
```

## Redis / Render Key Value

Created the Redis-compatible Key Value instance:

```powershell
~\OneDrive\Development\render.exe keyvalues create `
  --name mrl-media-redis `
  --plan free `
  --region ohio `
  --memory-policy queue `
  --confirm `
  --output json
```

Result:

```txt
id: red-d94bij1kh4rs73esroc0
name: mrl-media-redis
plan: free
region: ohio
memory policy: noeviction
internal URL used by services: redis://red-d94bij1kh4rs73esroc0:6379
```

Checks:

```powershell
~\OneDrive\Development\render.exe keyvalues get red-d94bij1kh4rs73esroc0 --output json
~\OneDrive\Development\render.exe keyvalues list --output json
```

## First Demo Web Service

This was the first free demo deploy. It ran API + worker inside one web service.
It was later deleted and replaced.

```powershell
$chars = 48..57 + 65..90 + 97..122
$secret = -join ($chars | Get-Random -Count 48 | ForEach-Object {[char]$_})
$admin = "adm_" + (-join ($chars | Get-Random -Count 32 | ForEach-Object {[char]$_}))

~\OneDrive\Development\render.exe services create `
  --name mrl-media `
  --type web_service `
  --repo https://github.com/Eshan05/MRL-Media `
  --branch main `
  --runtime docker `
  --region ohio `
  --plan free `
  --num-instances 1 `
  --health-check-path /health `
  --env-var "REDIS_URL=redis://red-d94bij1kh4rs73esroc0:6379" `
  --env-var "TRUST_PROXY=1" `
  --env-var "WEBHOOK_ALLOW_PRIVATE=0" `
  --env-var "RUN_WORKER=1" `
  --env-var "BETTER_AUTH_SECRET=$secret" `
  --env-var "ADMIN_KEY=$admin" `
  --confirm `
  --output json
```

Result:

```txt
old service id: srv-d94bjd5ckfvc739mbqg0
url: https://mrl-media.onrender.com
```

Deleted before resume-grade redeploy:

```powershell
~\OneDrive\Development\render.exe services delete srv-d94bjd5ckfvc739mbqg0 --confirm --output json
```

## Postgres

Created Render Postgres:

```powershell
~\OneDrive\Development\render.exe postgres create `
  --name mrl-media-db `
  --database-name mrl_media `
  --database-user mrl_media `
  --plan free `
  --region ohio `
  --confirm `
  --output json
```

Result:

```txt
id: dpg-d94faepkh4rs73f4no3g-a
name: mrl-media-db
database: mrl_media
user: mrl_media
plan: free
expires: 2026-08-03
```

Status check:

```powershell
~\OneDrive\Development\render.exe postgres get dpg-d94faepkh4rs73f4no3g-a --output json
```

The CLI hides the connection string, so I used the Render API with the CLI auth
token from `~/.render/cli.yaml`. Do not print the response in shared logs,
because it contains the database password.

```powershell
$cfg = Get-Content $HOME\.render\cli.yaml -Raw
$key = [regex]::Match($cfg, "key:\s*(\S+)").Groups[1].Value
$headers = @{ Authorization = "Bearer $key" }

$db = (
  Invoke-RestMethod `
    -Headers $headers `
    -Uri "https://api.render.com/v1/postgres/dpg-d94faepkh4rs73f4no3g-a/connection-info"
).internalConnectionString
```

Expected internal connection string shape:

```txt
postgresql://mrl_media:<password>@dpg-d94faepkh4rs73f4no3g-a/mrl_media
```

## Resume-Grade API Web Service

Created the API-only web service:

```powershell
$cfg = Get-Content $HOME\.render\cli.yaml -Raw
$key = [regex]::Match($cfg, "key:\s*(\S+)").Groups[1].Value
$headers = @{ Authorization = "Bearer $key" }
$db = (
  Invoke-RestMethod `
    -Headers $headers `
    -Uri "https://api.render.com/v1/postgres/dpg-d94faepkh4rs73f4no3g-a/connection-info"
).internalConnectionString

$chars = 48..57 + 65..90 + 97..122
$secret = -join ($chars | Get-Random -Count 48 | ForEach-Object {[char]$_})
$admin = "adm_" + (-join ($chars | Get-Random -Count 32 | ForEach-Object {[char]$_}))

~\OneDrive\Development\render.exe services create `
  --name mrl-media `
  --type web_service `
  --repo https://github.com/Eshan05/MRL-Media `
  --branch main `
  --runtime docker `
  --region ohio `
  --plan free `
  --num-instances 1 `
  --health-check-path /health `
  --start-command "node scripts/render-start.mjs" `
  --env-var "REDIS_URL=redis://red-d94bij1kh4rs73esroc0:6379" `
  --env-var "DATABASE_URL=$db" `
  --env-var "STORAGE_DRIVER=database" `
  --env-var "TRUST_PROXY=1" `
  --env-var "WEBHOOK_ALLOW_PRIVATE=0" `
  --env-var "RUN_WORKER=0" `
  --env-var "BETTER_AUTH_SECRET=$secret" `
  --env-var "ADMIN_KEY=$admin" `
  --confirm `
  --output json
```

Result:

```txt
service id: srv-d94fc67lk1mc73b6uf3g
deploy id: dep-d94fc6flk1mc73b6ugcg
url: https://mrl-media.onrender.com
status: live
```

Checks:

```powershell
~\OneDrive\Development\render.exe deploys list srv-d94fc67lk1mc73b6uf3g --output json
~\OneDrive\Development\render.exe logs --resources srv-d94fc67lk1mc73b6uf3g --limit 120 --output text
Invoke-RestMethod -Uri https://mrl-media.onrender.com/health | ConvertTo-Json -Depth 5
```

Current expected health while no background worker exists:

```json
{
  "ok": true,
  "queueDepth": 0,
  "worker": {
    "alive": false
  }
}
```

## Background Worker Attempt

Tried to create the proper Render Background Worker on the free plan:

```powershell
$cfg = Get-Content $HOME\.render\cli.yaml -Raw
$key = [regex]::Match($cfg, "key:\s*(\S+)").Groups[1].Value
$headers = @{ Authorization = "Bearer $key" }
$db = (
  Invoke-RestMethod `
    -Headers $headers `
    -Uri "https://api.render.com/v1/postgres/dpg-d94faepkh4rs73f4no3g-a/connection-info"
).internalConnectionString

~\OneDrive\Development\render.exe services create `
  --name mrl-media-worker `
  --type background_worker `
  --repo https://github.com/Eshan05/MRL-Media `
  --branch main `
  --runtime docker `
  --region ohio `
  --plan free `
  --num-instances 1 `
  --start-command "pnpm exec tsx src/worker/index.ts" `
  --env-var "REDIS_URL=redis://red-d94bij1kh4rs73esroc0:6379" `
  --env-var "DATABASE_URL=$db" `
  --env-var "STORAGE_DRIVER=database" `
  --env-var "WEBHOOK_ALLOW_PRIVATE=0" `
  --confirm `
  --output json
```

Render rejected it:

```txt
Error: received response code 400: only web services allowed for plan
```

That means a proper split Render worker needs a paid worker plan, likely
`starter`. I stopped there because that would create paid infrastructure.

## Useful Follow-Up Commands

List all current resources:

```powershell
~\OneDrive\Development\render.exe services --output json
~\OneDrive\Development\render.exe keyvalues list --output json
~\OneDrive\Development\render.exe postgres list --output json
```

Watch API logs:

```powershell
~\OneDrive\Development\render.exe logs --resources srv-d94fc67lk1mc73b6uf3g --tail
```

Trigger an API redeploy:

```powershell
~\OneDrive\Development\render.exe deploys create srv-d94fc67lk1mc73b6uf3g
```

Create the paid worker after explicit approval:

```powershell
~\OneDrive\Development\render.exe services create `
  --name mrl-media-worker `
  --type background_worker `
  --repo https://github.com/Eshan05/MRL-Media `
  --branch main `
  --runtime docker `
  --region ohio `
  --plan starter `
  --num-instances 1 `
  --start-command "pnpm exec tsx src/worker/index.ts" `
  --env-var "REDIS_URL=redis://red-d94bij1kh4rs73esroc0:6379" `
  --env-var "DATABASE_URL=$db" `
  --env-var "STORAGE_DRIVER=database" `
  --env-var "WEBHOOK_ALLOW_PRIVATE=0" `
  --confirm `
  --output json
```

For real S3/R2 storage, change env vars on recreated services:

```txt
STORAGE_DRIVER=s3
S3_BUCKET=<bucket>
S3_REGION=<region-or-auto>
S3_ENDPOINT=<optional-s3-compatible-endpoint>
S3_ACCESS_KEY_ID=<secret>
S3_SECRET_ACCESS_KEY=<secret>
S3_FORCE_PATH_STYLE=0
```
