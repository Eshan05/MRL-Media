-- Layer 2 exact sliding-window log.
-- Stores one ZSET member per admitted request unit, scored by request time.
-- This is exact but higher-cardinality than the weighted approximation.
--
-- KEYS[1]  zset key, e.g. rl:swlog:user:<userId>
-- ARGV[1]  limit
-- ARGV[2]  window ms
-- ARGV[3]  now ms
-- ARGV[4]  cost (positive integer)
-- ARGV[5]  unique request member prefix
--
-- Returns { allowed 0|1, remaining, resetAt ms }

local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)

local count = redis.call('ZCARD', KEYS[1])
local allowed = (count + cost) <= limit

if allowed then
  for i = 1, cost do
    redis.call('ZADD', KEYS[1], now, member .. ':' .. i)
  end
  count = count + cost
  redis.call('PEXPIRE', KEYS[1], window * 2)
end

local remaining = limit - count
if remaining < 0 then remaining = 0 end

local reset_at = now
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    reset_at = tonumber(oldest[2]) + window + 1
  end
end

return { allowed and 1 or 0, remaining, reset_at }
