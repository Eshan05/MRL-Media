-- Layer 5: GCRA (Generic Cell Rate Algorithm).
-- Guarantees SPACING between allowed calls, not just a count per window.
-- Entire state is one number: TAT (theoretical arrival time) — when the
-- next perfectly-paced request "should" arrive.
--
--   tat   = max(stored_tat, now)
--   allow if (tat - now) <= tau        -- tau = tolerated burst, in ms
--   on allow: store tat + interval
--
-- With tau = 0 requests must be at least `interval` apart. With
-- tau = (burst-1)*interval, `burst` calls may arrive back-to-back, then
-- spacing is enforced again — exactly a token bucket, expressed in time.
--
-- KEYS[1]  base key, e.g. rl:gcra:webhook:<destinationHost>
-- ARGV[1]  emission interval ms (1 req / 2s -> 2000)
-- ARGV[2]  tau ms (burst tolerance)
-- ARGV[3]  now ms (injected)
-- ARGV[4]  cost (consumes cost * interval)
--
-- Returns { allowed 0|1, retryAt ms }. retryAt == now when allowed;
-- otherwise the earliest instant the call would be allowed.

local interval = tonumber(ARGV[1])
local tau      = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local tat = now
local stored = redis.call('GET', KEYS[1])
if stored then
  tat = tonumber(stored)
  if tat < now then tat = now end
end

local allowed = (tat - now) <= tau
local retry_at = now

if allowed then
  local new_tat = tat + interval * cost
  -- once TAT has drained past now+tau the key is equivalent to absent
  redis.call('SET', KEYS[1], tostring(new_tat), 'PX',
             math.ceil(new_tat - now + tau + interval))
else
  retry_at = tat - tau
end

return { allowed and 1 or 0, retry_at }
