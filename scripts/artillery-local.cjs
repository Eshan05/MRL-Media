'use strict';

let n = 0;
const run = Date.now();
const ipPool = Number(process.env.ARTILLERY_IP_POOL ?? 4_000);

function seed(context, _events, done) {
  const id = n++;
  const ip = id % ipPool;
  context.vars.userId = `art-${run}-${id}`;
  context.vars.ip = `10.80.${Math.floor(ip / 250)}.${(ip % 250) + 1}`;
  done();
}

module.exports = { seed };
