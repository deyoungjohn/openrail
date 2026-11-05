// Prints the PUBLIC key for a NEAR ed25519 secret key read from stdin. The secret is never printed.
//   secret-tool lookup service openrail name issuer-fc-key | node tools/pubkey.mjs
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc = (buf) => {
  let n = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
};
const dec = (s) => {
  let n = 0n;
  for (const c of s) {
    const d = A.indexOf(c);
    if (d < 0) throw new Error("not base58");
    n = n * 58n + BigInt(d);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) {
    if (c === "1") zeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
};
let input = "";
for await (const chunk of process.stdin) input += chunk;
const secret = input.trim();
if (!secret.startsWith("ed25519:")) {
  console.error("NOT_AN_ED25519_SECRET");
  process.exit(1);
}
const bytes = dec(secret.slice(8));
if (bytes.length !== 64) {
  console.error("UNEXPECTED_LENGTH " + bytes.length);
  process.exit(1);
}
console.log("ed25519:" + enc(bytes.subarray(32)));
