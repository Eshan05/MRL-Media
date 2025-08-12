-- Layer 3: token bucket with lazy refill.
-- State is a hash { tokens, ts }. Nothing ticks in the background —
-- each call computes how many tokens accrued since the last one:
--   tokens = min(capacity, tokens + elapsed_seconds * rate)
--
-- KEYS[1]  base key, e.g. rl:tb:upload:<userId>
-- ARGV[1]  capacity (burst size)
-- ARGV[2]  refill rate, tokens per second (may be fractional)
-- ARGV[3]  now ms (injected)
-- ARGV[4]  cost
--
-- Returns { allowed 0|1, remaining tokens (floored), resetAt ms }.
-- resetAt: now if allowed; else when `cost` tokens will have accrued.

local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  -- unknown id starts with a full bucket
  tokens = capacity
  ts = now
end

local elapsed_s = (now - ts) / 1000
if elapsed_s > 0 then
  tokens = math.min(capacity, tokens + elapsed_s * rate)
end

local allowed = tokens >= cost
if allowed then
  tokens = tokens - cost
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
-- after 2 full idle refills the state is indistinguishable from a fresh
-- bucket, so let it expire
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) * 2)

local reset_at = now
if not allowed then
  reset_at = now + math.ceil(((cost - tokens) / rate) * 1000)
end

return { allowed and 1 or 0, math.floor(tokens), reset_at }
