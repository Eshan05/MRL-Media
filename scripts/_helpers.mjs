// Shared bits for the test scripts. Real auth means every simulated user
// is a real user row; the admin endpoint exists precisely so tests can mint
// users with deterministic age (30d → trust 1.0) and tier.
//
// The API instance under test must run with ADMIN_KEY set (default here
// matches the launch commands in README/TASK.md).

export const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin';

let mintN = 0;

export async function adminUser(base, { name = 'test-user', tier = 'free', ageDays = 30 } = {}) {
  // rotate source IPs so bulk minting never trips the layer-1 wall
  const n = mintN++;
  const res = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-key': ADMIN_KEY,
      'x-forwarded-for': `10.250.${Math.floor(n / 200) % 250}.${(n % 200) + 1}`,
    },
    body: JSON.stringify({ name, tier, ageDays }),
  });
  if (res.status !== 201) {
    throw new Error(`admin user create failed: ${res.status} ${await res.text()} — is the API running with ADMIN_KEY=${ADMIN_KEY}?`);
  }
  return res.json(); // { id, apiKey, tier }
}

export async function adminUsers(base, count, opts = {}) {
  const users = [];
  // small parallel batches — signup bursts shouldn't fight the IP limiter
  for (let i = 0; i < count; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - i) }, (_, j) =>
        adminUser(base, { ...opts, name: `${opts.name ?? 'bulk'}-${i + j}` }),
      ),
    );
    users.push(...batch);
  }
  return users;
}
