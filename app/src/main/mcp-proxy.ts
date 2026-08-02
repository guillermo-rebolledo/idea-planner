import { createConnection } from 'node:net'

const socketPath = process.env['APP_MCP_SOCKET']
const capability = process.env['APP_MCP_CAPABILITY']
if (!socketPath || !capability) throw new Error('The app MCP capability is required')

const socket = createConnection(socketPath)
socket.once('connect', () => {
  socket.write(`${JSON.stringify({ appCapability: capability })}\n`)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.once('error', () => process.exit(1))
process.stdin.once('end', () => socket.end())
