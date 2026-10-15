import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const chatId = process.argv[2]
if (!/^\d{4}-[A-Z0-9]{4}$/.test(chatId || '')) throw new Error('Usage: node scripts/local-key-change-test.mjs 7068-QKYB')
if (process.platform !== 'win32') throw new Error('This helper is for the local Windows test environment')
const config = readFileSync(fileURLToPath(new URL('../backend/config.yaml', import.meta.url)), 'utf8')
const dsn = process.env.MYSQL_DSN || config.match(/^\s*dsn:\s*"([^"]+)"/m)?.[1]
const settings = dsn?.match(/^([^:]+):(.*?)@tcp\((127\.0\.0\.1|localhost):(\d+)\)\/([A-Za-z0-9_]+)\?/)
if (!settings || settings[4] !== '3306') throw new Error('Only a local MySQL DSN on port 3306 is allowed')
const [, username, password, , port, database] = settings
const mysqlPath = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe'
const mysql = existsSync(mysqlPath) ? mysqlPath : 'mysql.exe'
function query(sql) {
  return execFileSync(mysql, ['--host=127.0.0.1', `--port=${port}`, `--user=${username}`, `--database=${database}`, '--batch', '--raw', '--skip-column-names'], {
    input: sql, encoding: 'utf8', env: { ...process.env, MYSQL_PWD: password }, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
const existing = query(`SELECT JSON_OBJECT('publicKey', public_key, 'ready', is_ready) FROM users WHERE chat_id = '${chatId}';`)
if (!existing) throw new Error('Test account was not found in the local database')
const account = JSON.parse(existing)
if (!account.ready || !account.publicKey) throw new Error('The test account has not completed registration')
const existingKey = createPublicKey({ key: Buffer.from(account.publicKey, 'base64'), format: 'der', type: 'spki' })
if (existingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The existing account does not use P-256')
const keys = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { format: 'der', type: 'spki' },
  privateKeyEncoding: { format: 'der', type: 'pkcs8' },
})
const localRoot = process.env.LOCALAPPDATA
if (!localRoot) throw new Error('LOCALAPPDATA is unavailable')
const outputRoot = join(localRoot, 'michat-key-test')
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, `${chatId}-`))
const owner = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
execFileSync('icacls.exe', [output, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`], { stdio: 'pipe' })
const privatePath = join(output, 'new-private-key.txt')
const publicPath = join(output, 'new-public-key.txt')
const publicKey = keys.publicKey.toString('base64')
writeFileSync(privatePath, keys.privateKey.toString('base64'), { flag: 'wx' })
writeFileSync(publicPath, publicKey, { flag: 'wx' })
const result = query(`UPDATE users SET public_key = '${publicKey}' WHERE chat_id = '${chatId}' AND public_key = '${account.publicKey}'; SELECT ROW_COUNT();`)
if (result !== '1') throw new Error('Account changed concurrently; the new key was not applied')
console.log(`Changed local test account: ${chatId}`)
console.log(`Database: 127.0.0.1:${port}/${database}`)
console.log(`New public key SHA-256: ${createHash('sha256').update(keys.publicKey).digest('hex')}`)
console.log(`New private key file: ${privatePath}`)
console.log(`New public key file: ${publicPath}`)
