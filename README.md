# WebsocketRelais

WebSocket-Relay fuer die GA-Dispatcher-Livetelemetrie.

## Bandbreiten-Schutz

Kontinuierliche GPS-Telemetrie wird pro sendender Verbindung auf maximal 2 Hz
gebuendelt. Der jeweils neueste Stand wird weitergeleitet; einmalige
Traffic-Snapshots bleiben dabei erhalten. Tracker-Befehle, ACKs und Heartbeats
werden weiterhin sofort zugestellt.

Der Standard von 500 ms kann bei Bedarf ueber
`RELAY_TELEMETRY_INTERVAL_MS` angepasst werden. Native WebSocket-Kompression
ist serverseitig fuer Nachrichten ab 512 Byte aktiviert.

Da der oeffentliche Render-Proxy `permessage-deflate` derzeit nicht bis zum
Client aushandelt, kann ein Browser beim Join additiv die Relay-Capability
`gzip-base64-v1` melden. Nur solche Empfaenger erhalten gebuendelte Telemetrie
als `relay_compressed`-Huelle; Legacy-Clients erhalten weiterhin unveraendertes
JSON. Befehle, ACKs und Heartbeats bleiben in beiden Faellen unkomprimiert.

## Tests

```sh
npm test
```
