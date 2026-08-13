const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { gzipSync } = require('node:zlib');

const DEFAULT_TELEMETRY_INTERVAL_MS = 500;
const COMPRESSION_THRESHOLD_BYTES = 512;
const STATS_INTERVAL_MS = 60_000;
const RELAY_GZIP_CAPABILITY = 'gzip-base64-v1';
const RELAY_GZIP_MESSAGE_TYPE = 'relay_compressed';

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageBytes(message) {
    if (Buffer.isBuffer(message)) return message.length;
    return Buffer.byteLength(String(message || ''), 'utf8');
}

function isRealtimeTelemetry(data) {
    return data?.type === 'gps'
        && data.commandOnly !== true
        && !data.trackerCommand
        && data.commandAckOnly !== true
        && data.trackerStatusOnly !== true;
}

// Traffic kommt nur alle paar Sekunden und wird vom Tracker danach geloescht.
// Wenn genau dieses Paket in ein Throttle-Fenster faellt, muss der letzte
// Traffic-Snapshot bis zur naechsten Weiterleitung erhalten bleiben.
function mergePendingTelemetry(previous, latest) {
    if (!previous || !Array.isArray(previous.traffic) || Array.isArray(latest?.traffic)) return latest;
    return { ...latest, traffic: previous.traffic };
}

function acceptsRelayGzip(data) {
    return Array.isArray(data?.relayCapabilities)
        && data.relayCapabilities.includes(RELAY_GZIP_CAPABILITY);
}

function createGzipEnvelope(serialized, originalType = '') {
    const payload = gzipSync(Buffer.from(serialized, 'utf8'), { level: 3 }).toString('base64');
    return JSON.stringify({
        type: RELAY_GZIP_MESSAGE_TYPE,
        encoding: RELAY_GZIP_CAPABILITY,
        originalType: String(originalType || ''),
        payload
    });
}

function createRelayServer(options = {}) {
    const app = express();
    const port = options.port ?? process.env.PORT ?? 8080;
    const telemetryIntervalMs = positiveNumber(
        options.telemetryIntervalMs ?? process.env.RELAY_TELEMETRY_INTERVAL_MS,
        DEFAULT_TELEMETRY_INTERVAL_MS
    );
    const logger = options.logger || console;

    app.get('/', (req, res) => res.send('GA Relay Server (Secured) läuft! 🚀'));
    const server = app.listen(port, () => logger.log(`Server lauscht auf Port ${server.address().port}`));
    const wss = new WebSocketServer({
        server,
        perMessageDeflate: {
            threshold: COMPRESSION_THRESHOLD_BYTES
        }
    });

    // Speichert fuer jeden Raum die verbundenen Clients UND den gueltigen PIN.
    const rooms = new Map();
    const stats = {
        inboundMessages: 0,
        inboundBytes: 0,
        forwardedMessages: 0,
        outboundCopies: 0,
        outboundBytesBeforeCompression: 0,
        outboundWireBytes: 0,
        gzipCopies: 0,
        gzipBytesSaved: 0,
        gzipErrors: 0,
        coalescedTelemetry: 0
    };

    const totalClients = () => {
        let count = 0;
        rooms.forEach(room => { count += room.clients.size; });
        return count;
    };

    const broadcast = (sender, room, data) => {
        const serialized = JSON.stringify(data);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        const recipients = [...room.clients].filter(
            client => client !== sender && client.readyState === WebSocket.OPEN
        );
        const gzipRecipients = isRealtimeTelemetry(data)
            ? recipients.filter(client => client.relayAcceptsGzip === true)
            : [];
        let gzipSerialized = null;
        let gzipBytes = 0;
        if (gzipRecipients.length > 0 && bytes >= COMPRESSION_THRESHOLD_BYTES) {
            try {
                const candidate = createGzipEnvelope(serialized, data.type);
                const candidateBytes = Buffer.byteLength(candidate, 'utf8');
                if (candidateBytes < bytes) {
                    gzipSerialized = candidate;
                    gzipBytes = candidateBytes;
                }
            } catch (error) {
                stats.gzipErrors += 1;
                logger.error('Relay-Gzip fehlgeschlagen; sende Legacy-JSON:', error);
            }
        }
        let copies = 0;
        recipients.forEach(client => {
            const useGzip = gzipSerialized && client.relayAcceptsGzip === true;
            client.send(useGzip ? gzipSerialized : serialized);
            copies += 1;
            stats.outboundWireBytes += useGzip ? gzipBytes : bytes;
            if (useGzip) {
                stats.gzipCopies += 1;
                stats.gzipBytesSaved += bytes - gzipBytes;
            }
        });
        stats.forwardedMessages += 1;
        stats.outboundCopies += copies;
        stats.outboundBytesBeforeCompression += bytes * copies;
    };

    const flushPendingTelemetry = (ws) => {
        const pending = ws.relayTelemetryPending;
        ws.relayTelemetryPending = null;
        ws.relayTelemetryTimer = null;
        if (!pending || ws.readyState !== WebSocket.OPEN) return;
        ws.relayTelemetryLastSentAt = Date.now();
        broadcast(ws, pending.room, pending.data);
    };

    const forwardTelemetry = (ws, room, data) => {
        const now = Date.now();
        const elapsed = now - ws.relayTelemetryLastSentAt;
        if (!ws.relayTelemetryTimer && elapsed >= telemetryIntervalMs) {
            ws.relayTelemetryLastSentAt = now;
            broadcast(ws, room, data);
            return;
        }

        const previous = ws.relayTelemetryPending?.data;
        ws.relayTelemetryPending = {
            room,
            data: mergePendingTelemetry(previous, data)
        };
        stats.coalescedTelemetry += 1;

        if (!ws.relayTelemetryTimer) {
            const delay = Math.max(1, telemetryIntervalMs - elapsed);
            ws.relayTelemetryTimer = setTimeout(() => flushPendingTelemetry(ws), delay);
        }
    };

    wss.on('connection', (ws) => {
        ws.relayTelemetryLastSentAt = 0;
        ws.relayTelemetryPending = null;
        ws.relayTelemetryTimer = null;
        ws.relayAcceptsGzip = false;

        ws.on('message', (messageAsString) => {
            stats.inboundMessages += 1;
            stats.inboundBytes += messageBytes(messageAsString);
            try {
                const data = JSON.parse(messageAsString);
                const syncId = data.syncId;
                const incomingPin = data.pin || '';

                if (!syncId) return;

                // Raum erstellen, falls er noch nicht existiert (der erste setzt das Passwort).
                if (!rooms.has(syncId)) {
                    rooms.set(syncId, { clients: new Set(), pin: incomingPin });
                }

                const room = rooms.get(syncId);

                // PIN-Pruefung: Ein falscher PIN beendet die Verbindung sofort.
                if (room.pin && room.pin !== incomingPin) {
                    logger.log(`Zugriff verweigert fuer Tracker-Raum (falscher PIN)`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Falscher PIN für diesen Tracker-Raum' }));
                    ws.close();
                    return;
                }

                if (data.type === 'join') {
                    ws.relayAcceptsGzip = acceptsRelayGzip(data);
                    room.clients.add(ws);
                    logger.log(
                        `Neues Geraet beigetreten. Clients im Raum: ${room.clients.size}; `
                        + `relay_gzip=${ws.relayAcceptsGzip ? 'yes' : 'no'}`
                    );
                    return;
                }

                if (data.type !== 'gps') return;

                if (isRealtimeTelemetry(data)) {
                    forwardTelemetry(ws, room, data);
                } else {
                    // Befehle, ACKs und Heartbeats duerfen nicht verzoegert werden.
                    broadcast(ws, room, data);
                }
            } catch (error) {
                logger.error('Fehler beim Verarbeiten der Nachricht:', error);
            }
        });

        ws.on('close', () => {
            if (ws.relayTelemetryTimer) clearTimeout(ws.relayTelemetryTimer);
            ws.relayTelemetryTimer = null;
            ws.relayTelemetryPending = null;
            rooms.forEach((roomData, syncId) => {
                roomData.clients.delete(ws);
                if (roomData.clients.size === 0) rooms.delete(syncId);
            });
        });
    });

    const statsInterval = setInterval(() => {
        if (stats.inboundMessages === 0 && stats.forwardedMessages === 0) return;
        logger.log(
            `[relay-stats] rooms=${rooms.size} clients=${totalClients()} `
            + `in_messages=${stats.inboundMessages} in_bytes=${stats.inboundBytes} `
            + `forwarded=${stats.forwardedMessages} copies=${stats.outboundCopies} `
            + `out_bytes_raw=${stats.outboundBytesBeforeCompression} out_bytes_wire=${stats.outboundWireBytes} `
            + `gzip_copies=${stats.gzipCopies} gzip_saved=${stats.gzipBytesSaved} gzip_errors=${stats.gzipErrors} `
            + `coalesced=${stats.coalescedTelemetry}`
        );
        Object.keys(stats).forEach(key => { stats[key] = 0; });
    }, STATS_INTERVAL_MS);
    statsInterval.unref?.();

    const close = async () => {
        clearInterval(statsInterval);
        wss.clients.forEach(client => client.terminate());
        await new Promise((resolve, reject) => {
            wss.close(error => {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
            });
        });
        if (server.listening) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };

    return { app, server, wss, rooms, stats, telemetryIntervalMs, close };
}

if (require.main === module) createRelayServer();

module.exports = {
    DEFAULT_TELEMETRY_INTERVAL_MS,
    RELAY_GZIP_CAPABILITY,
    RELAY_GZIP_MESSAGE_TYPE,
    acceptsRelayGzip,
    createRelayServer,
    createGzipEnvelope,
    isRealtimeTelemetry,
    mergePendingTelemetry
};
