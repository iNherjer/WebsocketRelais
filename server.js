const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const port = process.env.PORT || 8080;

// Render.com braucht einen normalen HTTP-Endpunkt (eine Webseite), um zu prüfen, ob der Server online ist.
app.get('/', (req, res) => res.send('GA Relay Server läuft! 🚀'));

const server = app.listen(port, () => console.log(`Server lauscht auf Port ${port}`));

// WebSocket Server an den HTTP Server binden
const wss = new WebSocketServer({ server });

// Hier speichern wir, wer in welchem "Raum" (Sync ID) ist
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (messageAsString) => {
        try {
            const data = JSON.parse(messageAsString);
            const syncId = data.syncId;

            if (!syncId) return;

            // Raum erstellen, falls er noch nicht existiert
            if (!rooms.has(syncId)) {
                rooms.set(syncId, new Set());
            }

            // 1. Ein Gerät betritt den Raum (Handy oder MSFS)
            if (data.type === 'join') {
                rooms.get(syncId).add(ws);
                console.log(`Neues Gerät in Raum ${syncId} beigetreten.`);
            }

            // 2. Ein Gerät funkt GPS-Daten -> An alle ANDEREN im Raum weiterleiten
            if (data.type === 'gps') {
                const room = rooms.get(syncId);
                room.forEach(client => {
                    // Nicht an sich selbst zurückschicken und prüfen ob Verbindung noch offen ist (1)
                    if (client !== ws && client.readyState === 1) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) {
            console.error('Fehler beim Verarbeiten der Nachricht:', e);
        }
    });

    // Wenn ein Gerät offline geht, aufräumen
    ws.on('close', () => {
        rooms.forEach((clients, syncId) => {
            clients.delete(ws);
            if (clients.size === 0) rooms.delete(syncId);
        });
    });
});
