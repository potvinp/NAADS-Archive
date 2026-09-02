#!/usr/bin/env node
'use strict';

// Manage accounts for the optional auth layer (see src/auth.js). Works
// whether or not NAADS_AUTH is set, so you can create the first user before
// turning auth on -- and can never lock yourself out of an enabled install.
//
// Usage:
//   node bin/user.js add <username> [--admin]
//   node bin/user.js list
//   node bin/user.js passwd <username>
//   node bin/user.js role <username> <user|admin>
//   node bin/user.js rm <username>
const readline = require('readline');
const auth = require('../src/auth');

const RESERVED = auth.GUEST_USERNAME;

let rl = null;
function closeRl() {
  if (rl) { rl.close(); rl = null; }
}

// Masked interactive prompt. Only used on a real TTY -- readline's terminal
// machinery (which the masking relies on) misbehaves on piped stdin.
function promptMasked(question) {
  return new Promise((resolve) => {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (str) => { if (str.includes(question)) rl.output.write(question); };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      closeRl();
      resolve(answer);
    });
  });
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

/**
 * A new password, from (in order): $NAADS_NEW_PASSWORD, an interactive
 * masked prompt with confirmation on a TTY, or the first non-empty line of
 * piped stdin (for scripts / Docker).
 */
async function readNewPassword() {
  if (process.env.NAADS_NEW_PASSWORD) return process.env.NAADS_NEW_PASSWORD;

  if (!process.stdin.isTTY) {
    const pw = (await readAllStdin()).split(/\r?\n/).find((line) => line.length > 0);
    if (!pw) throw new Error('no password supplied (pipe one in, or set NAADS_NEW_PASSWORD)');
    return pw;
  }

  const p1 = await promptMasked('New password: ');
  if (!p1) throw new Error('password cannot be empty');
  const p2 = await promptMasked('Confirm password: ');
  if (p1 !== p2) throw new Error('passwords did not match');
  return p1;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'add': {
      const username = (args[0] || '').trim();
      const role = args.includes('--admin') ? 'admin' : 'user';
      if (!username) throw new Error('usage: user.js add <username> [--admin]');
      if (username === RESERVED) throw new Error(`"${RESERVED}" is reserved`);
      if (await auth.getUserByUsername(username)) throw new Error(`user "${username}" already exists`);
      const password = await readNewPassword();
      await auth.createUser(username, password, role);
      console.log(`Created ${role} "${username}".`);
      break;
    }
    case 'list': {
      const users = await auth.listUsers();
      if (!users.length) { console.log('(no users)'); break; }
      for (const u of users) console.log(`${u.role.padEnd(6)} ${u.username}`);
      break;
    }
    case 'passwd': {
      const username = (args[0] || '').trim();
      if (!username) throw new Error('usage: user.js passwd <username>');
      if (!(await auth.getUserByUsername(username))) throw new Error(`no such user "${username}"`);
      const password = await readNewPassword();
      await auth.setPassword(username, password);
      console.log(`Password updated for "${username}".`);
      break;
    }
    case 'role': {
      const username = (args[0] || '').trim();
      const role = (args[1] || '').trim();
      if (!username || !['user', 'admin'].includes(role)) throw new Error('usage: user.js role <username> <user|admin>');
      if (username === RESERVED) throw new Error(`"${RESERVED}" is reserved`);
      const changed = await auth.setRole(username, role);
      if (!changed) throw new Error(`no such user "${username}"`);
      console.log(`"${username}" is now ${role}.`);
      break;
    }
    case 'rm': {
      const username = (args[0] || '').trim();
      if (!username) throw new Error('usage: user.js rm <username>');
      if (username === RESERVED) throw new Error(`"${RESERVED}" is reserved`);
      const removed = await auth.deleteUser(username);
      if (!removed) throw new Error(`no such user "${username}"`);
      console.log(`Deleted "${username}".`);
      break;
    }
    default:
      console.log('Usage:\n' +
        '  node bin/user.js add <username> [--admin]\n' +
        '  node bin/user.js list\n' +
        '  node bin/user.js passwd <username>\n' +
        '  node bin/user.js role <username> <user|admin>\n' +
        '  node bin/user.js rm <username>');
      process.exitCode = cmd ? 1 : 0;
  }
}

main()
  .then(() => { closeRl(); process.exit(process.exitCode || 0); })
  .catch((err) => {
    closeRl();
    console.error(err.message || err);
    process.exit(1);
  });
