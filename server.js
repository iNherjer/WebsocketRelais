const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const port = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('GA Relay Server (Secured) läuft! 🚀'));
const server = app.listen(port, () => console.log(`Server lauscht auf Port ${port}`));

const wss = new WebSocketServer({ server });

// Speichert für jeden Raum die verbundenen Clients UND den gültigen PIN
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (messageAsString) => {
        try {
            const data = JSON.parse(messageAsString);
            const syncId = data.syncId;
            const incomingPin = data.pin || ''; // PIN aus der Payload lesen

            if (!syncId) return;

            // Raum erstellen, falls er noch nicht existiert (Der erste setzt das Passwort)
            if (!rooms.has(syncId)) {
                rooms.set(syncId, { clients: new Set(), pin: incomingPin });
            }

            const room = rooms.get(syncId);

            // PIN PRÜFUNG (Türsteher)
            // Wenn der Raum schon existiert und der einkommende PIN nicht passt -> RAUSWURF
            if (room.pin && room.pin !== incomingPin) {
                console.log(`Zugriff verweigert für ID: ${syncId} (Falscher PIN)`);
                ws.send(JSON.stringify({ type: 'error', message: 'Falscher PIN für diesen Tracker-Raum' }));
                ws.close(); // Verbindung knallhart beenden
                return;
            }

            // 1. Gerät betritt den Raum
            if (data.type === 'join') {
                room.clients.add(ws);
                console.log(`Neues Gerät in Raum ${syncId} beigetreten.`);
            }

            // 2. Gerät funkt GPS-Daten
            if (data.type === 'gps') {
                room.clients.forEach(client => {
                    if (client !== ws && client.readyState === 1) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) {
            console.error('Fehler beim Verarbeiten der Nachricht:', e);
        }
    });

    ws.on('close', () => {
        rooms.forEach((roomData, syncId) => {
            roomData.clients.delete(ws);
            // Wenn der Raum leer ist, wird er gelöscht (und der PIN resettet sich)
            if (roomData.clients.size === 0) {
                rooms.delete(syncId);
            }
        });
    });
});
