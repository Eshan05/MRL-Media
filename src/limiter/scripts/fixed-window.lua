-- Layer 1: fixed window counter.
-- Cheapest algorithm — one counter per (id, window). Used on the coarse
-- per-IP surface where cardinality is huge and the boundary-burst flaw
-- (up to 2x limit across a window edge) is acceptable.
--
-- KEYS[1]  base key, e.g. rl:fw:ip:1.2.3.4
-- ARGV[1]  limit      (max hits per window)
-- ARGV[2]  window ms
-- ARGV[3]  now ms     (injected by caller for deterministic tests)
-- ARGV[4]  cost       (hits this call consumes, usually 1)
-- ARGV[5]  count rejected 0|1
--
-- Returns { allowed 0|1, remaining, resetAt ms }

local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])
local count_rejected = tonumber(ARGV[5] or '0') == 1

local window_id = math.floor(now / window)
local key = KEYS[1] .. ':' .. window_id

local count = tonumber(redis.call('GET', key) or '0')
local allowed = (count + cost) <= limit

if allowed or count_rejected then
  count = redis.call('INCRBY', key, cost)
  if count == cost then
    -- first hit in this window: expire after 2 windows so stale keys vanish
    redis.call('PEXPIRE', key, window * 2)
  end
end

local remaining = limit - count
if remaining < 0 then remaining = 0 end
local reset_at = (window_id + 1) * window

return { allowed and 1 or 0, remaining, reset_at }
