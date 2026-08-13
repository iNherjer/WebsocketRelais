# WebsocketRelais

WebSocket-Relay fuer die GA-Dispatcher-Livetelemetrie.

## Bandbreiten-Schutz

Kontinuierliche GPS-Telemetrie wird pro sendender Verbindung auf maximal 2 Hz
gebuendelt. Der jeweils neueste Stand wird weitergeleitet; einmalige
Traffic-Snapshots bleiben dabei erhalten. Tracker-Befehle, ACKs und Heartbeats
werden weiterhin sofort zugestellt.

Der Standard von 500 ms kann bei Bedarf ueber
`RELAY_TELEMETRY_INTERVAL_MS` angepasst werden. WebSocket-Kompression wird fuer
Nachrichten ab 512 Byte ausgehandelt.

## Tests

```sh
npm test
```
