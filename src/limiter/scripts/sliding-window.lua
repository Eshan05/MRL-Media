-- Layer 2: sliding window (weighted approximation, Cloudflare-style).
-- Same two counters as fixed window, but the previous window fades out
-- gradually instead of being forgotten at the boundary:
--   estimate = prev * (1 - elapsed_fraction) + curr
-- Assumes prev's requests were evenly spread — that is the approximation.
--
-- Design choice: only ALLOWED requests are counted (same as fixed-window).
-- The alternative — counting rejected ones too — punishes clients that
-- hammer while blocked. See LEARNING.md layer 2.
--
-- KEYS[1]  base key, e.g. rl:sw:user:<userId>
-- ARGV[1]  limit
-- ARGV[2]  window ms
-- ARGV[3]  now ms (injected by caller for deterministic tests)
-- ARGV[4]  cost
--
-- Returns { allowed 0|1, remaining, resetAt ms }

local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])

local curr_id  = math.floor(now / window)
local curr_key = KEYS[1] .. ':' .. curr_id
local prev_key = KEYS[1] .. ':' .. (curr_id - 1)

local curr = tonumber(redis.call('GET', curr_key) or '0')
local prev = tonumber(redis.call('GET', prev_key) or '0')

local elapsed  = (now % window) / window
local estimate = prev * (1 - elapsed) + curr

local allowed = (estimate + cost) <= limit

if allowed then
  curr = redis.call('INCRBY', curr_key, cost)
  if curr == cost then
    -- first hit in this window: keep the key alive through the NEXT
    -- window, where it will play the role of prev
    redis.call('PEXPIRE', curr_key, window * 2)
  end
  estimate = estimate + cost
end

local remaining = math.floor(limit - estimate)
if remaining < 0 then remaining = 0 end
-- prev's weight hits zero at the next boundary — the honest reset point
local reset_at = (curr_id + 1) * window

return { allowed and 1 or 0, remaining, reset_at }
