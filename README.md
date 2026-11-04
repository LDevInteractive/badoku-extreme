# Badoku-Extreme (Ballon-Sudoku-Extreme)

Live-Partyspiel für 7 Spieler: Alle lösen gleichzeitig dasselbe Sudoku auf dem Handy.
Wer eine Zeile oder Spalte abschliesst, rennt los und holt einen Ballon. Die App leitet das
Spiel, es gibt keinen Moderator. Spielregeln und Architektur stehen vollständig in `CLAUDE.md`.

- **Frontend:** reines HTML/CSS/JS (ES-Module), kein Build, gehostet auf GitHub Pages.
- **Backend:** Supabase (Postgres + Realtime). Die ganze Spiellogik läuft in Postgres-Funktionen.

## Einrichtung

### 1. Supabase-Projekt

1. Auf [supabase.com](https://supabase.com) ein neues Projekt anlegen. Region **EU (Frankfurt)**.
   Datenbank-Passwort sicher ablegen (wird für die App nicht gebraucht).
2. Im Dashboard unter **Project Settings → API Keys** den **Publishable Key** kopieren
   (beginnt mit `sb_publishable_`). Unter **Project Settings → Data API** steht die **Project URL**
   (`https://<ref>.supabase.co`).
   Zeigt das Projekt nur die Legacy-Keys (`anon`, beginnt mit `eyJ…`), funktioniert der `anon`-Key
   gleichwertig.
3. Der `service_role`-Key (bzw. der neue Secret Key `sb_secret_…`) wird nirgends gebraucht.
   Nie ins Repo, nie ins Frontend.

### 2. Migrationen ausführen

Im Dashboard **SQL Editor** öffnen und die Dateien aus `supabase/migrations/` **in numerischer
Reihenfolge** einfügen und ausführen (eine Datei pro Lauf):

| Datei | Inhalt |
|---|---|
| `000_server_time.sql` | Smoke-Test-Funktion `server_time()` |
| `001_puzzles.sql` | Tabellen `puzzles` und `puzzle_solutions` (kein Client-Zugriff) |
| `002_schema.sql` | Spieltabellen |
| `003_security.sql` | RLS und Zugriffsrechte |
| `004_helpers.sql` | interne Helfer (Standard-Config, Farben, Token, PIN, Snapshot) |
| `005_game_rpc.sql` | RPCs der Lobby: `create_game`, `host_check`, `join_game`, `get_state`, `tick` |
| `006_realtime.sql` | `games` in die Publikation `supabase_realtime` |
| `007_round_rpc.sql` | Sudoku-Runde: `host_start_main`, `enter_digit`, Rundenlimit in `tick` |
| `008_hunt_rpc.sql` | Jagd: `hunt_press`, Erzeugung in `enter_digit`, Fristablauf, Ende bei der letzten Jagd |
| `009_break_rpc.sql` | Pausen: Shots verteilen, Zufall, Trinken, bereit, erzwingen, nächste Runde oder Kassensturz |
| `010_round_end_hold.sql` | Fertiges Raster bleibt am Rundenende mindestens `round_end_hold_s` sichtbar |
| `011_…` | folgen mit den nächsten Meilensteinen |

### 3. Frontend konfigurieren

In `js/config.js` die beiden Werte eintragen:

```js
export const SUPABASE_URL = 'https://<ref>.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_…';
```

Der Publishable Key ist dafür gemacht, öffentlich zu sein. Die Daten sind durch RLS und den
Zugriff ausschliesslich über RPC-Funktionen geschützt.

### 4. GitHub Pages

1. Öffentliches Repo `badoku-extreme` anlegen, dieses Verzeichnis pushen (`main`).
2. **Settings → Pages → Build and deployment:** Source «Deploy from a branch», Branch `main`,
   Ordner `/ (root)`. Speichern.
3. Nach 1–2 Minuten ist die Seite unter `https://ldevinteractive.github.io/badoku-extreme/` erreichbar.
4. Optional eigene Domain (`spiel.mebongs.ch`): CNAME beim DNS-Anbieter auf `ldevinteractive.github.io`,
   in den Pages-Einstellungen eintragen, «Enforce HTTPS» aktivieren.

### 5. Rätsel-Pool laden

```
node tools/generate-puzzles.mjs --seed 20261104
```

erzeugt `supabase/seed/puzzles.sql` (30 × 9×9 leicht, 15 × 9×9 mittel, 10 × 6×6, 10 × 4×4).
Diese Datei enthält die **Lösungen** und ist deshalb in `.gitignore`. Inhalt im SQL Editor
ausführen (Migration `001_puzzles.sql` muss vorher gelaufen sein). Die Datei ist idempotent,
mehrfaches Ausführen erzeugt keine Duplikate. Kontrolle:

```sql
select size, difficulty, count(*) from public.puzzles group by 1, 2 order by 1, 2;
```

Tests des Generators: `node --test tools/*.test.mjs` (oder `npm test` in `tools/`).

## Smoke-Test

`index.html` öffnen (auf GitHub Pages oder lokal, siehe unten). Die Karte **Systemcheck** zeigt:

- **Server:** Serverzeit, Umlaufzeit und Uhrversatz aus `server_time()`.
- **Realtime:** Status des Realtime-Kanals (`SUBSCRIBED` = grün).
- **Wake Lock:** Button «Aktivieren», danach 2 Minuten warten, der Bildschirm muss an bleiben.
  Funktioniert nur über HTTPS (GitHub Pages) oder `localhost`.

Alle drei Punkte müssen auf einem Handy grün sein, bevor es weitergeht.

## Lokal entwickeln

ES-Module laufen nicht per Doppelklick auf die Datei (`file://`), ein kleiner Webserver reicht:

```
npx serve .
```

oder `python -m http.server 8000`, dann `http://localhost:8000/` öffnen. Der Wake Lock
funktioniert auf `localhost` ebenfalls.

## Vor dem Anlass

- Supabase pausiert Gratisprojekte nach einer Woche Inaktivität. **Am Vortag im Dashboard
  prüfen und bei Bedarf «Restore» klicken.**
- Smoke-Test auf allen Handys durchklicken (Server, Realtime, Wake Lock grün).
- Laptop für den TV: Browser im Vollbild, Bildschirmschoner aus, Netzteil dran.

## Struktur

Siehe `CLAUDE.md` Abschnitt 9.1. Kurz: `index.html`, `tv.html`, `play.html` im Root,
Stile in `css/`, Module in `js/`, fixierte Drittbibliotheken in `vendor/`
(supabase-js 2.118.0, qrcode-generator 2.0.4), Datenbank in `supabase/`, lokale Werkzeuge
in `tools/`.
