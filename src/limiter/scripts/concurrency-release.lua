-- Layer 4: concurrency semaphore — release.
--
-- KEYS[1]  zset key (same as acquire)
-- ARGV[1]  holder id from the acquisition
--
-- Returns { released 0|1, in_use }. released=0 means the holder had
-- already been swept (its TTL passed) — worth logging when it happens,
-- because it means a job outlived its slot TTL.

local released = redis.call('ZREM', KEYS[1], ARGV[1])
local in_use = redis.call('ZCARD', KEYS[1])

return { released, in_use }
