// Anonymous/public-private upload verification.
// Requires the API with Redis/Postgres:
//   node scripts/e2e-anonymous.mjs [baseUrl]
import { adminUser } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const report = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

function form(name, text) {
  const fd = new FormData();
  fd.append('file', new File([text], name, { type: 'text/plain' }));
  return fd;
}

async function upload(headers, name, text) {
  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers,
    body: form(name, text),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return { res, body };
}

const anonPublic = await upload(
  { 'x-forwarded-for': '10.77.0.10', 'x-media-visibility': 'public' },
  'anon-public.txt',
  `anon public ${Date.now()}`,
);
report(
  'anonymous public upload -> 201',
  anonPublic.res.status === 201 &&
    anonPublic.body.actor === 'anonymous' &&
    anonPublic.body.visibility === 'public' &&
    anonPublic.body.expiresAt &&
    anonPublic.body.mediaUrl,
  `${anonPublic.res.status} ${JSON.stringify(anonPublic.body)}`,
);

const publicRead = await fetch(`${BASE}${anonPublic.body.mediaUrl}`);
report('anonymous public media reads without auth', publicRead.status === 200, `got ${publicRead.status}`);

const ownerOnlyAnon = await fetch(`${BASE}/files/${anonPublic.body.storedAs}`);
report('anonymous cannot use owner file route', ownerOnlyAnon.status === 401, `got ${ownerOnlyAnon.status}`);

const anonPrivate = await upload(
  { 'x-forwarded-for': '10.77.0.11', 'x-media-visibility': 'private' },
  'anon-private.txt',
  `anon private ${Date.now()}`,
);
report(
  'anonymous private upload returns one-time code link',
  anonPrivate.res.status === 201 &&
    anonPrivate.body.visibility === 'private' &&
    anonPrivate.body.privateCode &&
    anonPrivate.body.mediaUrl?.includes('code='),
  `${anonPrivate.res.status} ${JSON.stringify(anonPrivate.body)}`,
);

const privateBare = await fetch(`${BASE}/media/${anonPrivate.body.storedAs}`);
report('anonymous private media hides without code', privateBare.status === 404, `got ${privateBare.status}`);

const privateRead = await fetch(`${BASE}${anonPrivate.body.mediaUrl}`);
report('anonymous private media reads with code', privateRead.status === 200, `got ${privateRead.status}`);

const webhook = await upload(
  { 'x-forwarded-for': '10.77.0.12', 'x-webhook-url': 'https://example.com/hook' },
  'anon-webhook.txt',
  'webhook',
);
report('anonymous webhook is rejected', webhook.res.status === 401, `got ${webhook.res.status}`);

const invalidAuth = await upload(
  { 'x-forwarded-for': '10.77.0.13', authorization: 'Bearer not-a-real-key', 'x-media-visibility': 'public' },
  'bad-auth.txt',
  'bad auth',
);
report('invalid auth does not downgrade to anonymous', invalidAuth.res.status === 401, `got ${invalidAuth.res.status}`);

const user = await adminUser(BASE, { name: `share-${Date.now()}` });
const auth = { authorization: `Bearer ${user.apiKey}`, 'x-media-visibility': 'private' };
const owned = await upload(auth, 'owned-private.txt', 'owned private');
report('authenticated private upload -> 201', owned.res.status === 201 && owned.body.statusUrl, `${owned.res.status}`);

const listed = await fetch(`${BASE}/files`, { headers: { authorization: `Bearer ${user.apiKey}` } });
const listBody = await listed.json();
report('authenticated user sees own uploads', listed.status === 200 && listBody.files.some((f) => f.id === owned.body.id));

const makePublic = await fetch(`${BASE}/files/${owned.body.id}`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${user.apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'public' }),
});
const publicBody = await makePublic.json();
report('authenticated user can make file public', makePublic.status === 200 && publicBody.mediaUrl, `${makePublic.status}`);

const deleteOwned = await fetch(`${BASE}/files/${owned.body.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${user.apiKey}` },
});
report('authenticated user can delete own file', deleteOwned.status === 204, `got ${deleteOwned.status}`);

process.exit(results.every(Boolean) ? 0 : 1);
