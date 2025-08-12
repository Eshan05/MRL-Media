-- Layer 4: concurrency semaphore — heartbeat / extend.
--
-- KEYS[1]  zset key (same as acquire)
-- ARGV[1]  now ms
-- ARGV[2]  new ttl ms
-- ARGV[3]  holder id from the acquisition
--
-- Returns { extended 0|1, in_use }. extended=0 means the holder was already
-- expired/swept or never existed.

local now    = tonumber(ARGV[1])
local ttl    = tonumber(ARGV[2])
local holder = ARGV[3]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

local score = redis.call('ZSCORE', KEYS[1], holder)
if not score then
  return { 0, redis.call('ZCARD', KEYS[1]) }
end

redis.call('ZADD', KEYS[1], 'XX', now + ttl, holder)
redis.call('PEXPIRE', KEYS[1], ttl * 2)

return { 1, redis.call('ZCARD', KEYS[1]) }
