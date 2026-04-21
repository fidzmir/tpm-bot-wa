# Heartbeat Ping System 💓

This heartbeat system keeps your WhatsApp bot **always on** by sending periodic pings to maintain an active connection.

## Features

- **Automatic Connection Maintenance**: Sends heartbeat pulses every 30 seconds (configurable)
- **Internal WhatsApp Ping**: Keeps the WhatsApp socket connection alive
- **External HTTP Ping**: Optional external endpoint pinging for cloud services (prevents idle timeouts)
- **On-Demand Control**: Start, stop, restart, or adjust the heartbeat via API endpoints

## How It Works

1. **Auto-Start**: Heartbeat automatically starts when WhatsApp connects
2. **Auto-Stop**: Heartbeat automatically stops when WhatsApp disconnects
3. **Periodic Ping**: Sends keep-alive messages at set intervals
4. **Silent Operation**: Pings are sent as temporary "view once" messages so they don't clutter chats

## Configuration

### In `index.js`:

```javascript
const heartbeat = new HeartbeatManager({
    interval: 30000, // Ping every 30 seconds (in milliseconds)
    externalPingUrl: null // Add external URL to ping, e.g., "https://your-app.com/ping"
    // externalPingUrl: "https://your-cloud-app.com/keep-alive"
});
```

### Recommended Intervals:
- **5000ms (5s)** - Very aggressive, highest uptime guarantee
- **10000ms (10s)** - Aggressive, good for unstable connections
- **30000ms (30s)** - Standard, balanced approach (DEFAULT)
- **60000ms (1m)** - Relaxed, lower resource usage
- **120000ms (2m)** - Very relaxed, minimal overhead

## API Endpoints

### 1. Check Heartbeat Status
```bash
GET http://localhost:8080/heartbeat/status

Response:
{
    "isActive": true,
    "interval": 30000,
    "whatsappConnected": true
}
```

### 2. Change Heartbeat Interval
```bash
POST http://localhost:8080/heartbeat/interval
Content-Type: application/json

{
    "interval": 20000
}

Response:
{
    "message": "Heartbeat interval changed to 20000ms",
    "interval": 20000
}
```

### 3. Stop Heartbeat
```bash
POST http://localhost:8080/heartbeat/stop

Response:
{
    "message": "Heartbeat stopped"
}
```

### 4. Restart Heartbeat
```bash
POST http://localhost:8080/heartbeat/restart

Response:
{
    "message": "Heartbeat restarted"
}
```

## Usage Examples

### Using cURL:

```bash
# Check status
curl http://localhost:8080/heartbeat/status

# Change to 20 seconds
curl -X POST http://localhost:8080/heartbeat/interval \
  -H "Content-Type: application/json" \
  -d '{"interval": 20000}'

# Stop heartbeat
curl -X POST http://localhost:8080/heartbeat/stop

# Restart heartbeat
curl -X POST http://localhost:8080/heartbeat/restart
```

### Using JavaScript/Node.js:

```javascript
// Check status
fetch('http://localhost:8080/heartbeat/status')
  .then(r => r.json())
  .then(data => console.log(data));

// Change interval
fetch('http://localhost:8080/heartbeat/interval', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ interval: 15000 })
});
```

## External Ping URL (Optional)

If you're deploying on a cloud service that terminates idle connections:

```javascript
const heartbeat = new HeartbeatManager({
    interval: 30000,
    externalPingUrl: "https://your-app.com/ping" // Cloud service keep-alive endpoint
});
```

The heartbeat will ping this URL every 30 seconds to prevent idle timeout.

## Console Logs

You'll see logs like:

```
💓 Starting Heartbeat Ping (every 30 seconds)
💚 Heartbeat OK - 10:45:23 AM
💚 Heartbeat OK - 10:45:53 AM
📡 External ping successful
❌ Heartbeat error: [error message]
💔 Heartbeat stopped
```

## Troubleshooting

### Heartbeat not starting?
- ✅ Check that WhatsApp is connected first (`sock` must exist)
- ✅ Check browser console for error messages
- ✅ Verify heartbeat status with `/heartbeat/status` endpoint

### Too many temporary messages?
- Lower the `interval` value (pings less frequently)
- Messages are sent as "view once" so they disappear automatically

### Connection still dropping?
- Lower the interval (e.g., 15000ms instead of 30000ms)
- Add an `externalPingUrl` for cloud services
- Check your network/firewall settings

### High CPU/Memory usage?
- Increase the interval (e.g., 60000ms or 120000ms)
- Disable external pings if not needed

## Best Practices

1. **For Codespaces/Free Cloud**: Use 30-60 second intervals
2. **For Production Servers**: Use 10-30 second intervals
3. **For Unstable Networks**: Use 5-10 second intervals
4. **Monitor Logs**: Check console output for heartbeat status
5. **Test API Endpoints**: Verify heartbeat is running with status endpoint

## Files Included

- `heartbeat.js` - Main heartbeat manager class
- `index.js` - Integration with Express server and WhatsApp bot
- `HEARTBEAT_README.md` - This documentation

---

Keep your bot running 24/7! 🚀💚
