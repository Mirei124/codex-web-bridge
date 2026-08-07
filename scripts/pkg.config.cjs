const { dirname, join, relative } = require("node:path");
const { createRequire } = require("node:module");

const root = join(__dirname, "..");
const serverRequire = createRequire(join(root, "apps/server/package.json"));
const betterSqlite = join(dirname(require.resolve("better-sqlite3")), "../build/Release/better_sqlite3.node");
const argon2Main = serverRequire.resolve("@node-rs/argon2");
const argon2 = createRequire(argon2Main).resolve("@node-rs/argon2-linux-x64-gnu");
const ssh2Crypto = join(dirname(require.resolve("ssh2")), "protocol/crypto/build/Release/sshcrypto.node");

module.exports = {
  assets: [
    "../apps/web/dist/**/*",
    relative(__dirname, betterSqlite),
    relative(__dirname, argon2),
    relative(__dirname, ssh2Crypto),
  ],
  publicPackages: "*",
  fallbackToSource: true,
};
