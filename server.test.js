const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const {
    createRelayServer,
    isRealtimeTelemetry,
    mergePendingTelemetry
} = require('./server.js');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function send(ws, payload) {
    ws.send(JSON.stringify(payload));
}

test('classifies only continuous GPS packets as realtime telemetry', () => {
    assert.equal(isRealtimeTelemetry({ type: 'gps', lat: 1, lon: 2, flight: {} }), true);
    assert.equal(isRealtimeTelemetry({ type: 'gps', commandOnly: true, trackerCommand: {} }), false);
    assert.equal(isRealtimeTelemetry({ type: 'gps', commandAckOnly: true }), false);
    assert.equal(isRealtimeTelemetry({ type: 'gps', trackerStatusOnly: true }), false);
});

test('keeps a one-shot traffic snapshot while replacing queued telemetry', () => {
    const merged = mergePendingTelemetry(
        { type: 'gps', lat: 1, traffic: [{ id: 'traffic-1' }] },
        { type: 'gps', lat: 2 }
    );
    assert.equal(merged.lat, 2);
    assert.deepEqual(merged.traffic, [{ id: 'traffic-1' }]);
});

test('coalesces telemetry but forwards commands immediately', async (t) => {
    const silentLogger = { log() {}, error() {} };
    const relay = createRelayServer({ port: 0, telemetryIntervalMs: 80, logger: silentLogger });
    t.after(async () => relay.close());
    await new Promise(resolve => relay.server.listening ? resolve() : relay.server.once('listening', resolve));

    const address = relay.server.address();
    const sender = await connect(`ws://127.0.0.1:${address.port}`);
    const receiver = await connect(`ws://127.0.0.1:${address.port}`);
    t.after(() => sender.terminate());
    t.after(() => receiver.terminate());
    assert.match(sender.extensions, /permessage-deflate/);
    assert.match(receiver.extensions, /permessage-deflate/);

    const received = [];
    receiver.on('message', raw => received.push(JSON.parse(raw)));
    const room = { syncId: 'hotfix-test', pin: '1234' };
    send(sender, { type: 'join', ...room });
    send(receiver, { type: 'join', ...room });
    await wait(20);

    for (let index = 0; index < 10; index += 1) {
        send(sender, {
            type: 'gps',
            ...room,
            lat: index,
            lon: index,
            flight: {},
            ...(index === 3 ? { traffic: [{ id: 'traffic-1' }] } : {})
        });
        await wait(10);
    }

    send(sender, {
        type: 'gps',
        ...room,
        commandOnly: true,
        trackerCommand: { type: 'mission_snapshot_update' }
    });
    await wait(120);

    const telemetry = received.filter(message => !message.commandOnly);
    const commands = received.filter(message => message.commandOnly);
    assert.ok(telemetry.length >= 2 && telemetry.length <= 3, `unexpected telemetry count: ${telemetry.length}`);
    assert.equal(telemetry.at(-1).lat, 9);
    assert.ok(telemetry.some(message => Array.isArray(message.traffic)));
    assert.equal(commands.length, 1);
    assert.equal(relay.telemetryIntervalMs, 80);
    assert.ok(relay.stats.coalescedTelemetry >= 7);
});
