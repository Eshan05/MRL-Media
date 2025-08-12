-- Layer 3: token bucket read-only peek.
-- Computes the same lazy refill math as token-bucket.lua, but deliberately
-- does not write tokens or ts. A read should not create or refresh limiter
-- state; the next real check can recompute the same elapsed refill.
--
-- KEYS[1]  base key, e.g. rl:tb:upload:<userId>
-- ARGV[1]  capacity
-- ARGV[2]  refill rate, tokens per second
-- ARGV[3]  now ms
-- ARGV[4]  cost
--
-- Returns { remaining tokens (floored), resetAt ms }.

local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed_s = (now - ts) / 1000
if elapsed_s > 0 then
  tokens = math.min(capacity, tokens + elapsed_s * rate)
end

local reset_at = now
if tokens < cost then
  reset_at = now + math.ceil(((cost - tokens) / rate) * 1000)
end

return { math.floor(tokens), reset_at }
