import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())

// Create an HTTP server (needed for WebSockets)
const server = http.createServer(app)

// Create a WebSocket server
const wss = new WebSocketServer({ server })

// In-memory store for rooms (WebSocket connections)
const rooms: Record<
  string,
  {
    drawings: any[]
    history: any[][]
    redoStack: any[][]
    users: WebSocket[]
    startTime: number
  }
> = {}

// REST API endpoint to create a room via HTTP POST
app.post('/create-room', (req, res) => {
  // Generate room ID
  const roomId = generateRoomId()
  // Initialize in-memory room data
  rooms[roomId] = {
    drawings: [],
    history: [[]],
    redoStack: [],
    users: [],
    startTime: Date.now()
  }

  res.json({
    event: 'room-created',
    data: { roomId }
  })
})

const broadcast = (
  roomId: string,
  message: string,
  currentUser?: WebSocket
) => {
  rooms[roomId].users.forEach((client) => {
    if (currentUser && client === currentUser) return
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

const checkAndDeleteRoom = (roomId: string) => {
  const room = rooms[roomId]
  if (room && room.users.length === 0) {
    const elapsedTime = Date.now() - room.startTime
    if (elapsedTime >= 5 * 60 * 1000) {
      delete rooms[roomId]
      console.log(`Room ${roomId} deleted due to inactivity.`)
    }
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  // Use the URL constructor to parse the query string
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const roomId = url.searchParams.get('room')
  const username = url.searchParams.get('username')

  if (!roomId) {
    ws.close()
    console.log('Room ID not provided. Closing connection.')
    return
  }

  // Handle incoming messages from clients
  ws.on('message', (data: string) => {
    // process events
    const { event, data: eventData } = JSON.parse(data)

    if (event === 'join-room') {
      const { roomId, username } = eventData
      if (rooms[roomId]) {
        // When a user joins a room, add their WebSocket to the room's list
        rooms[roomId].users.push(ws)

        // Notify others in the room that a user joined
        broadcast(
          roomId,
          JSON.stringify({
            event: 'user-joined',
            data: { username }
          }),
          ws
        )
      }
    }

    if (event === 'draw') {
      const { roomId, ...drawData } = eventData
      if (!rooms[roomId]) return

      if (drawData.strokes.length === 0) return
      rooms[roomId].drawings.push(drawData)
      rooms[roomId].history.push([...rooms[roomId].drawings]) // Save history
      rooms[roomId].redoStack = [] // Clear redoStack when a new drawing happens

      broadcast(roomId, JSON.stringify({ event: 'draw', data: drawData }), ws)
    }

    if (event === 'undo') {
      if (!rooms[roomId]) return

      if (rooms[roomId].history.length > 1) {
        rooms[roomId].redoStack.push([...rooms[roomId].drawings]) // Save redo history
        rooms[roomId].drawings = rooms[roomId].history.pop() || []
        broadcast(
          roomId,
          JSON.stringify({
            event: 'update-canvas',
            data: rooms[roomId].drawings
          })
        )
      }
    }

    if (event === 'redo') {
      if (!rooms[roomId]) return

      if (rooms[roomId].redoStack.length > 0) {
        rooms[roomId].history.push([...rooms[roomId].drawings]) // Save current state before redoing
        rooms[roomId].drawings = rooms[roomId].redoStack.pop() || []
        broadcast(
          roomId,
          JSON.stringify({
            event: 'update-canvas',
            data: rooms[roomId].drawings
          })
        )
      }
    }

    if (event === 'clear') {
      if (!rooms[roomId]) return

      rooms[roomId].history.push([...rooms[roomId].drawings]) // Save history before clearing
      rooms[roomId].redoStack = [] // Clear redo stack
      rooms[roomId].drawings = []
      broadcast(
        roomId,
        JSON.stringify({ event: 'update-canvas', data: rooms[roomId].drawings })
      )
    }
  })

  // When a client disconnects, remove them from the room's list
  ws.on('close', () => {
    if (rooms[roomId]) {
      rooms[roomId].users = rooms[roomId]?.users?.filter(
        (client) => client !== ws
      )
      // Check if the room should be deleted
      checkAndDeleteRoom(roomId)
    }
    console.log(`Client ${username} disconnected`)
  })
})

// Helper function to generate a unique room ID
const generateRoomId = (): string => {
  return Math.random().toString(36).substring(2, 8)
}

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
