-- Layer 4: concurrency semaphore — acquire.
-- Slots are members of a ZSET scored by their expiry deadline. A worker
-- that crashes without releasing simply stops refreshing; its deadline
-- passes and the next acquire sweeps it out. The TTL is the safety valve
-- that makes crashed holders unable to leak slots forever.
--
-- KEYS[1]  zset key, e.g. rl:cc:transcode:<userId>
-- ARGV[1]  max slots
-- ARGV[2]  now ms (injected)
-- ARGV[3]  slot ttl ms (generously > the longest legitimate job)
-- ARGV[4]  holder id (unique per acquisition)
--
-- Returns { acquired 0|1, in_use }

local max_slots = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])
local ttl       = tonumber(ARGV[3])
local holder    = ARGV[4]

-- sweep holders whose deadline has passed (crashed / stuck workers)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

local in_use = redis.call('ZCARD', KEYS[1])
local acquired = in_use < max_slots

if acquired then
  redis.call('ZADD', KEYS[1], now + ttl, holder)
  in_use = in_use + 1
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
end

return { acquired and 1 or 0, in_use }
