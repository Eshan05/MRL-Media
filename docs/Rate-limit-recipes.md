# Render Rate Limit Recipes

PowerShell commands for manually proving each limiter against the Render deploy.

```powershell
$base = "https://mrl-media.onrender.com"
$small = "$env:TEMP\mrl-small.txt"
"hello" | Set-Content -NoNewline $small

$signup = @{
  name = "rl-test"
  email = "rl-$([guid]::NewGuid())@test.local"
  password = "password-12345"
} | ConvertTo-Json

$key = (Invoke-RestMethod -Method Post -Uri "$base/signup" -ContentType "application/json" -Body $signup).apiKey
```

## L1: Fixed Window Per IP

```powershell
for ($i=1; $i -le 105; $i++) {
  $out = curl.exe -s -i -H "x-forwarded-for: 198.51.100.77" "$base/health"
  if ($out -match "429") { $out; break }
}
```

Expected: `429` with `layer: fixed-window-ip`.

## L2: Sliding Window Per User

Pace uploads so the token bucket does not fire first.

```powershell
for ($i=1; $i -le 20; $i++) {
  $out = curl.exe -s -i -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -F "file=@$small;filename=l2-$i.txt"

  if ($out -match "429") { $out; break }
  Start-Sleep -Milliseconds 2100
}
```

Expected: `429` with `layer: sliding-window-user`.

## L3: Token Bucket Upload Burst

Use a fresh key if earlier tests already recorded violations on the current key.

```powershell
for ($i=1; $i -le 8; $i++) {
  $out = curl.exe -s -i -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -F "file=@$small;filename=l3-$i.txt"

  if ($out -match "429") { $out; break }
}
```

Expected: `429` with `layer: token-bucket-upload`.

## L4: Concurrency Semaphore

Free users have 2 upload slots. Start two slow uploads, then immediately run a third.

```powershell
$big = "$env:TEMP\mrl-big.bin"
fsutil file createnew $big 30000000

Start-Job { param($base,$key,$big)
  curl.exe -i --limit-rate 20k -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -F "file=@$big;type=application/octet-stream"
} -ArgumentList $base,$key,$big

Start-Job { param($base,$key,$big)
  curl.exe -i --limit-rate 20k -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -F "file=@$big;type=application/octet-stream"
} -ArgumentList $base,$key,$big

curl.exe -i --limit-rate 20k -X POST "$base/upload" `
  -H "authorization: Bearer $key" `
  -F "file=@$big;type=application/octet-stream"
```

Expected: `429`, `x-rl-inflight: 2/2`, and `layer: concurrency-upload`.

## L5: GCRA Webhook Pacing

This requires a live worker.

```powershell
Invoke-RestMethod "$base/health" | ConvertTo-Json -Depth 5
```

If `worker.alive` is false, GCRA webhook pacing cannot be proven on Render yet.
If worker is alive, use a webhook.site/ngrok URL:

```powershell
$hook = "https://webhook.site/your-id"

for ($i=1; $i -le 4; $i++) {
  curl.exe -s -i -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -H "x-webhook-url: $hook" `
    -F "file=@$small;filename=l5-$i.txt"
}
```

Expected: uploads return `201`; webhook deliveries are delayed/paced. With burst
`2`, the first two may arrive close together, then later deliveries should be
roughly `2s` apart. This layer delays jobs; it is not a 429 response.

## L6: Adaptive Trust

Check trust before and after a deliberate violation.

```powershell
curl.exe -i -X POST "$base/upload" `
  -H "authorization: Bearer $key" `
  -F "file=@$small;filename=trust-before.txt"
```

Look for `x-rl-trust`.

Then trigger violations, usually through L3:

```powershell
for ($i=1; $i -le 8; $i++) {
  curl.exe -s -i -X POST "$base/upload" `
    -H "authorization: Bearer $key" `
    -F "file=@$small;filename=trust-violate-$i.txt"
}

Start-Sleep -Seconds 10

curl.exe -i -X POST "$base/upload" `
  -H "authorization: Bearer $key" `
  -F "file=@$small;filename=trust-after.txt"
```

Expected: `x-rl-trust` is lower after recent violations. L6 changes effective
limits for L2-L4; it is not a standalone 429 layer.
