# CLAUDE.md – Badoku-Extreme

> Projektkontext für Claude Code. Diese Datei ist die verbindliche Spezifikation.
> Bei Widersprüchen zwischen Code und dieser Datei: **nachfragen**, nicht raten.

---

## 0. Arbeitsweise (zwingend)

- **Sprache:** Kommunikation mit mir auf Deutsch. UI-Texte Deutsch (Schweizer Schreibweise, kein «ß»). Code, Bezeichner, Kommentare im Code: Englisch.
- **Analyse zuerst, ändern danach.** Vor jedem Meilenstein kurz den Plan nennen (Dateien, Ansatz), dann umsetzen.
- **Nach jedem Meilenstein stoppen**, Ergebnis zusammenfassen, sagen, was ich testen soll, und auf mein OK warten. Ich teste mit Screenshots.
- **Vollständige Dateien**, keine Platzhalter wie `// ... rest unchanged`, keine TODO-Stubs in abgeschlossenen Meilensteinen.
- **Keine Abhängigkeiten aus CDNs.** Drittbibliotheken werden als fixierte Version in `vendor/` eingecheckt.
- **Kein Build-Schritt** für das Frontend. Reines HTML/CSS/JS (ES-Module), direkt von GitHub Pages ausgeliefert.
- **Dokumentation:** Diese Datei nur nach meiner ausdrücklichen Freigabe ändern. Entscheidungen zwischendurch im Chat sammeln.
- **Secrets:** Der Supabase `service_role`-Key kommt nie ins Repo und nie ins Frontend. Sudoku-**Lösungen** kommen nie ins Repo (öffentliches Repo!).

---

## 1. Worum es geht

Ein Live-Partyspiel für **7 Spieler** an einem Spielnachmittag in einer Lagerhalle. Dauer **30–45 Minuten**. Es gibt **keinen Moderator**: Die App leitet das Spiel. Der Spielleiter (Luca) spielt selbst mit und kennt die Rätsel nicht.

**Kernidee:** Alle lösen gleichzeitig dasselbe Sudoku auf dem eigenen Handy. Wer als Erster eine Zeile oder Spalte mit **seiner eigenen Eingabe** abschliesst, sperrt sie für sich, und sie wird für alle aufgedeckt. Er legt das Handy hin und hat **50 Sekunden**, um in der Halle einen der versteckten Ballone zu holen und in sein Depot am Platz zu werfen. In den Ballonen stecken 3D-gedruckte Euro-Münzen. Am Ende werden die Ballone geplatzt, und wer am meisten Geld hat, gewinnt. Gelöste Linien geben zudem **Shots**, die in den Pausen zwischen den Sudokus an Mitspieler verteilt werden.

**Geräte:**
- **TV-Ansicht** (`tv.html`): Laptop am TV/Beamer. Zeigt Lobby mit QR-Code, aufgedecktes Raster, Timer, Ticker, Jagden, Pausen, Kassensturz, Rangliste. Treibt die Spielzeit voran (Tick, siehe §5.4).
- **Spieleransicht** (`play.html`): Handy jedes Spielers.

---

## 2. Spielregeln (vollständige Spezifikation)

### 2.1 Ablauf

```
LOBBY ─► PROBERUNDE 4×4 (zählt nicht) ─► LOBBY (bereit)
      ─► HAUPTSPIEL: [ SUDOKU 9×9 ─► PAUSE (Shots) ]  × n
      ─► KASSENSTURZ ─► (POWERSUDOKU 6×6 bei Gleichstand) ─► RANGLISTE & STATISTIK
```

### 2.2 Lobby & Beitritt
- Der Host erstellt auf dem TV ein Spiel mit einer **Host-PIN** (4–6 Ziffern). Das System vergibt einen **4-stelligen Spielcode**.
- Die TV-Lobby zeigt einen grossen **QR-Code** auf `play.html?g=<CODE>` und den Code in Grossschrift.
- Spieler treten mit **Name** (max. 16 Zeichen, eindeutig im Spiel) und **Farbe** bei. Farben sind fest vorgegeben, jede nur einmal wählbar (siehe §6.3).
- Max. Spieler: `config.max_players` (Standard 7, für Tests 2–8 erlaubt).
- Gerät verloren / Browser gewechselt: Der Host kann mit PIN einen bestehenden Spieler einem neuen Gerät zuweisen («Spieler übernehmen»).
- Beim ersten Tippen nach dem Beitritt aktiviert die Spieleransicht den **Wake Lock** (Bildschirm bleibt an) – das Handy liegt während der Jagd am Tisch.

### 2.3 Proberunde (4×4)
- Ein 4×4-Sudoku (Boxen 2×2), damit alle den Ablauf kennen.
- Gleiche Mechanik wie das Hauptspiel (Eingabe, Fehler, Sperre, Linie gelöst, Jagd-Animation, Button), aber:
  - Niemand rennt wirklich. Jagd-Zeiten verkürzt (`trial_hunt_duration_s` 15, `trial_hunt_min_press_s` 5).
  - **Keine Shots, keine Statistik, zählt nicht** zu den 35 Jagden und nicht zum 25-Minuten-Limit.
  - Die Jagd-Texte auf dem Handy sagen, dass niemand rennt und dass das Ergebnis nicht zählt.
- Danach zurück in die Lobby, der Host startet das Hauptspiel oder wiederholt die Proberunde. Sie ist beliebig oft wiederholbar.

### 2.4 Sudoku-Runde (9×9)
- Alle spielen **dasselbe Rätsel** (vom Server zufällig aus dem Pool gewählt, nie zweimal im selben Spiel).
- Schwierigkeit: **ohne Notizen lösbar** (nur Singles, siehe §7). Kein Notizmodus in der UI.
- **Jede Eingabe wird sofort serverseitig geprüft.** Falsche Ziffern werden nicht übernommen.
- Nur **Zeilen und Spalten** zählen als Linien (9 + 9 = 18). 3×3-Boxen zählen nicht.
- **Rundenlimit:** `round_limit_s` = 480 s (8 Min.). Danach werden alle noch offenen Linien neutral aufgedeckt.
- Eine Runde endet, wenn **alle 18 Linien gesperrt** sind (beansprucht oder neutral) oder das Rundenlimit erreicht ist. Laufende Jagden werden immer zuerst abgeschlossen.
- Das fertige Raster bleibt nach Rundenende mindestens `round_end_hold_s` = 5 s stehen, damit alle die Lösung sehen, auch wenn keine Jagd mehr läuft. TV und Handys zeigen es; wer auf eine laufende Jagd wartet, sieht auf dem Handy «Runde beendet – warte auf laufende Jagden».

### 2.5 Fehler & Sperre
- Der **erste Fehler** startet ein Fenster von `error_window_s` = 30 s.
- Der **3. Fehler innerhalb dieses Fensters** löst eine Sperre von `lock_s` = 20 s aus (Eingabe auf dem eigenen Handy gesperrt, Countdown-Overlay).
- Läuft das Fenster ohne 3. Fehler ab, beginnt der Zähler wieder bei 0. Nach einer Sperre beginnt der Zähler ebenfalls bei 0.
- Sperren und Fehler geben **keine Shots**.

### 2.6 Linie beanspruchen, Aufdecken, Neutral
- Eine Linie ist für Spieler P **vollständig**, wenn jede Zelle entweder Vorgabe, bereits aufgedeckt oder von P korrekt eingegeben ist.
- **Beansprucht** wird eine Linie nur, wenn **P's eigene korrekte Eingabe** sie vollständig macht und die Linie noch nicht gesperrt ist. Sie wird in P's Farbe gesperrt, und ihre Ziffern werden **für alle aufgedeckt**.
- Eine Eingabe kann **Zeile und Spalte gleichzeitig** abschliessen: Beide Linien gehören P (2 Linien, 2 Shots), aber es gibt **nur 1 Jagd**.
- **Neutral:** Ist eine Linie allein durch Vorgaben + aufgedeckte Zellen vollständig (niemand hat sie durch eigene Eingabe abgeschlossen), wird sie **neutral** gesperrt (grau, keine Jagd, keine Shots). Wird nach jedem Aufdecken geprüft.
- Wird eine Linie für P nur durch Aufdecken vollständig (aber nicht global), passiert nichts. P kann sie nicht mehr beanspruchen («Pech gehabt»). Andere Spieler können sie weiterhin beanspruchen.
- Zellen in gesperrten Linien sind für alle ausgefüllt und nicht mehr eingebbar.
- **Farbe:** Eine gesperrte Linie zeigt durchgehend die Farbe ihres Lösers (neutral: grau) und wird nie überschrieben. Darstellung siehe §9.5.

### 2.7 Jagd
- Beim Beanspruchen startet sofort eine Jagd (sofern noch Ballone in der Halle sind, siehe §2.8):
  - Vollbild-Animation in Grün: «ZEILE 4 GELÖST!» bzw. «SPALTE 7 GELÖST!» (bei beiden: «ZEILE 4 + SPALTE 7»).
  - Countdown `hunt_duration_s` = **50 s** (Server-Frist).
  - Grosser Button **«BALLON IM DEPOT»**, erst nach `hunt_min_press_s` = **10 s** aktiv (Fortschrittsbalken bis dahin). Verhindert Drücken beim Wegrennen.
  - **Regel (analog):** Das Handy bleibt am Tisch.
- Button vor Fristende gedrückt → **Erfolg**: Der Spieler darf beim Kassensturz einen Ballon mehr platzen lassen.
- Frist abgelaufen → **Fehlschlag**. Bringt der Spieler trotzdem einen Ballon mit, darf er ihn ins Depot legen, aber er zählt nicht.
- Während einer eigenen Jagd ist die Eingabe gesperrt.
- TV zeigt alle laufenden Jagden mit Spielerfarbe und Countdown-Balken.

### 2.8 Ballone & Spielende
- In der Halle sind `balloons_total` = **35** Ballone (7 Spieler × 5).
- **Jede gestartete Jagd** zählt einen Ballon aus der Halle (egal ob Erfolg oder Fehlschlag). TV zeigt «Ballone in der Halle: x».
- Wird die **35. Jagd gestartet**, endet das Spiel **sofort**: keine Eingaben mehr, laufende Jagden abschliessen, letzte Pause (Shots), dann Kassensturz.
- **Zeitlimit:** Ein neues Sudoku darf nur starten, solange seit Start des ersten Haupt-Sudokus **weniger als `game_limit_s` = 1500 s (25 Min.)** vergangen sind (Pausen zählen mit). Ein Sudoku, das bei 24:59 startet, wird fertig gespielt.
- Danach: letzte Pause, dann Kassensturz.

### 2.9 Pause zwischen Sudokus (Shots)
> In der UI heisst es immer «Shot»/«Shots». Bezeichner im Code und in der Datenbank bleiben `sip`/`sips`.

Zwei Teilphasen:

**a) Verteilen** (`break_distribute`)
- Jeder Spieler hat `sips_per_line` = 1 Shot **pro in dieser Runde beanspruchter Linie** zu verteilen.
- Er tippt auf Mitspieler (jedes Tippen = 1 Shot). Alle an eine Person ist erlaubt. **An sich selbst ist verboten.**
- Button **«Zufall»**: verteilt alle restlichen Shots, jeden einzeln an einen zufälligen Mitspieler (nie an sich selbst).
- Wer nichts zu verteilen hat, sieht «Nichts zu verteilen – warte auf die anderen».
- Nach `distribute_timeout_s` = 60 s werden restliche Shots automatisch per Zufall verteilt.
- TV zeigt live, wer wem wie viele Shots gibt.

**b) Trinken & bereit** (`break_drink`)
- Jeder sieht: «Du musst X Shots trinken» plus Liste, von wem.
- Ein Button **«Getrunken & bereit»** (auch bei 0 Shots).
- Sind alle bereit, startet das nächste Sudoku (oder der Kassensturz, siehe §2.8).
- Hängt jemand: Nach `force_continue_after_s` = 120 s erscheint auf dem TV «Weiter erzwingen» (Host-PIN).

### 2.10 Kassensturz
- TV zeigt pro Spieler: **«darf N Ballone platzen lassen»** (N = erfolgreiche Jagden). Hat jemand mehr Ballone im Depot, wählt er selbst aus, welche er platzen lässt (analog).
- Geplatzt und gezählt wird **am Tisch, analog**. Die App kennt die Münzen nicht.
- Jeder gibt auf seinem Handy seinen **Gesamtbetrag** ein (Format `1.37` → intern Cent, ganzzahlig, 0 bis `cash_max_cents`).
- TV zeigt, wer schon eingegeben hat (✓), **Beträge bleiben verborgen**. Korrektur möglich, bis der Host mit PIN **«Kassensturz abschliessen»** drückt (nur möglich, wenn alle eingegeben haben).
- Danach: Beträge werden auf dem TV mit Hochzähl-Animation enthüllt. Plausibilitätsanzeige: «Summe aller Eingaben: x.xx € von max. `coins_total_cents`».
- Nach `cash_reveal_s` = 10 s folgt von selbst das Powersudoku oder die Rangliste, ohne Knopf. Die Limite des Powersudokus beginnt erst danach; bis dahin zeigen die Handys der Beteiligten einen Countdown, die übrigen «Schau auf den TV».

### 2.11 Rangliste & Powersudoku
- Rang nach Betrag absteigend.
- **Jede** Gruppe mit gleichem Betrag (≥ 2 Spieler) spielt das **Powersudoku 6×6** (Boxen 2 Zeilen × 3 Spalten). Alle Gruppen spielen **parallel dasselbe Rätsel**, nicht Beteiligte schauen zu.
- Limit `tiebreak_limit_s` = 90 s. Gleiche Fehler-/Sperrregeln wie §2.5. Keine Linien, keine Jagd.
- Wer in seiner Gruppe **zuerst fertig** ist, beendet das Powersudoku **für seine Gruppe** und belegt den besten Rang der Gruppe. Die übrigen der Gruppe werden nach Anzahl korrekter Zahlen gereiht, dann nach früherer letzter korrekter Eingabe. Bleibt danach noch Gleichstand: Losentscheid durch den Server (auf dem TV als «Los» gekennzeichnet).
- Danach: **Rangliste 1–7** (für die Siegertabelle des Spielleiters) und **Statistik**.

### 2.12 Statistik (Endbildschirm TV, eigene Werte auf dem Handy)
- Betrag, Rang
- Beanspruchte Linien (gesamt / pro Runde), schnellste Linie (Zeit ab Rundenstart)
- Jagden: gestartet / erfolgreich / Quote
- Fehler gesamt, ausgelöste Sperren
- Shots verteilt / erhalten (inkl. «Lieblingsopfer»: an wen am meisten verteilt)
- Auszeichnungen: Linien-König, Jagd-Profi (beste Quote, min. `award_min_hunts` = 2 Jagden), Fehlerteufel, Shot-Magnet (am meisten erhalten), Grosszügigster (am meisten verteilt)

---

## 3. Analoger Teil (zur Info, keine Software)

- Jeder befüllt 5 Ballone mit Münzen. Danach werden **alle Ballone gemischt** und verteilt versteckt, sodass niemand weiss, wo welcher Ballon ist und was drin ist.
- Münzen: 3D-gedrucktes Euro-Münzset (MakerWorld-Modell 213524), es kommen nur Werte bis 1 € in die Ballone.
- Offen (Entscheid Spielleiter, betrifft die Software nicht): genaue Münzverteilung; Regel «Angefasst ist genommen» gegen Abtasten.
- Jeder hat ein Depot (Korb) am Platz. Depots sind tabu.
- Versteckzone markieren, ebenerdig, kein Klettern.

---

## 4. Technischer Rahmen

| Thema | Entscheid |
|---|---|
| Frontend-Hosting | **GitHub Pages**, statisch, direkt aus `main` / Root. URL `https://<user>.github.io/badoku-extreme/` |
| Backend | **Supabase** (Postgres + Realtime). Temporär für diesen Anlass. Region: EU (Frankfurt). |
| Spiellogik | **Komplett serverseitig in Postgres-Funktionen** (RPC, `SECURITY DEFINER`). Das Frontend ist ein reines Anzeige-/Eingabegerät. |
| Frontend | Vanilla HTML/CSS/JS, ES-Module, kein Framework, kein Build. |
| Bibliotheken | `vendor/supabase.js` (supabase-js v2, UMD-Build, fixierte Version, eingecheckt), `vendor/qrcode.js` (qrcode-generator, MIT, eingecheckt). Sonst nichts. |
| Tools (nur lokal) | Node ≥ 20 in `tools/` für Rätsel-Generator, Tests, Bot-Simulation. |
| Optional | Eigene Domain `spiel.mebongs.ch`: CNAME bei Infomaniak auf `<user>.github.io`, in den Pages-Einstellungen eintragen, «Enforce HTTPS». Nicht Teil der Meilensteine. |

**Wichtige Konsequenzen:**
- GitHub Pages ist statisch, es gibt keinen eigenen Server-Prozess. Deshalb: Autorität in Postgres, Zeitsteuerung per Tick (§5.4).
- Kostenloses GitHub Pages braucht ein **öffentliches Repo** → keine Lösungen und keine Secrets im Repo.
- Supabase-Gratisprojekte werden nach längerer Inaktivität pausiert → vor dem Anlass im Dashboard prüfen.
- HTTPS ist durch GitHub Pages gegeben → Wake Lock API funktioniert.

---

## 5. Architektur

### 5.1 Grundprinzipien
1. **Der Server entscheidet alles.** Clients senden Absichten («Ziffer 7 in Zelle 23»), der Server prüft und ändert den Zustand.
2. **Serialisierung pro Spiel:** Jede verändernde Funktion sperrt zuerst die Spielzeile (`SELECT … FROM games WHERE … FOR UPDATE`). Damit laufen alle Aktionen eines Spiels nacheinander – keine Race Conditions (z.B. zwei Spieler schliessen gleichzeitig dieselbe Zeile ab: Wer zuerst die Sperre bekommt, gewinnt).
3. **Alle Fristen sind Server-Zeitstempel** (`now()` in Postgres). Clients zeigen Countdowns nur an, korrigiert um den gemessenen Uhrzeitversatz.
4. **Snapshot statt Diffs:** Jede verändernde Funktion erhöht `games.version`. Clients abonnieren per Realtime **nur** Änderungen an ihrer `games`-Zeile. Bei Versionswechsel holen sie den kompletten Zustand per `get_state` (entprellt, ca. 100 ms). Bei 7 Spielern ist das trivial und extrem robust (Reconnect = einfach neu laden).
5. **Fallback-Polling:** Ist der Realtime-Kanal nicht `SUBSCRIBED`, pollen Clients `get_state` alle 2 s. Bei `visibilitychange` → sofort neu laden.
6. **Geheimnisse bleiben im Server:** Lösungen, Token-Hashes, PIN-Hash liegen in Tabellen ohne Leserechte. Clients erhalten nur, was sie sehen dürfen.

### 5.2 Sicherheit
- Der Supabase **Publishable Key** (früher «anon key») liegt öffentlich in `js/config.js` – das ist so vorgesehen.
- **RLS ist auf allen Tabellen aktiv.** Einzige Leserechte-Policy: `games` (für Realtime). Diese Tabelle enthält nichts Geheimes. Alle anderen Tabellen haben **keine** Policies; Zugriff nur über RPCs.
- `revoke all` auf alle Tabellen für `anon`/`authenticated`, ausser `select` auf `games`. `grant execute` nur auf die öffentlichen RPCs.
- **Spieler-Token:** Beim Beitritt erzeugt der Server ein zufälliges Token (32 Byte, hex), speichert nur den SHA-256-Hash. Das Token liegt im `localStorage` des Handys (in `try/catch`, Fallback: nur Speicher). Jede Spieleraktion übergibt Code + Token.
- **Host-PIN:** gespeichert als bcrypt-Hash (`extensions.crypt` / `gen_salt('bf')`, pgcrypto liegt in Supabase im Schema `extensions`).
- Akzeptiertes Restrisiko (Ehrenkodex): Vorgaben sind sichtbar, jemand könnte das Rätsel mit einem Online-Solver lösen.

### 5.3 Zustandsautomat (`games.phase`)

```
lobby ──host_start_trial──► trial_running ──(alle Linien / Limit)──► trial_ending ──(Jagden fertig)──► lobby (trial_done = true)
lobby ──host_start_main───► round_running
round_running ──(18 Linien gesperrt | Rundenlimit | 35. Jagd gestartet)──► round_ending
round_ending ──(keine aktive Jagd und round_end_hold_s vorbei)──► break_distribute   (überspringen, wenn niemand Shots hat → break_drink)
break_distribute ──(alle verteilt | Timeout → Zufall)──► break_drink
break_drink ──(alle bereit | Host erzwingt)──► round_running   wenn hunts_started < 35 UND Spielzeit < 25 Min.
                                            └─► cashout          sonst
cashout ──host_close_cashout──► tiebreak (falls Gleichstand) ──(alle Gruppen fertig)──► results
                             └─► results (kein Gleichstand)
```

Die Enthüllung der Beträge (§2.10) ist keine eigene Phase: Sie läuft am Anfang von `tiebreak` bzw. `results`, ihr Ende steht in `phase_deadline`. Bei `results` nach einem Powersudoku ist `phase_deadline` leer, es wird nichts mehr enthüllt.

Jede Aktion ist nur in bestimmten Phasen erlaubt; sonst gibt die RPC `{ok:false, reason:'wrong_phase'}` zurück (kein Fehler werfen, Client ignoriert still).

### 5.4 Zeitsteuerung: `tick(code)`
Es gibt keinen Server-Prozess, der Fristen überwacht. Lösung: **idempotente Funktion `tick(code)`**, die alle zeitabhängigen Übergänge anhand von `now()` prüft:
- Aktive Jagden mit abgelaufener Frist → `failed`.
- `round_running`/`trial_running` über Rundenlimit → offene Linien neutral aufdecken → `round_ending`/`trial_ending`.
- `round_ending`/`trial_ending` ohne aktive Jagd und nach `round_end_hold_s` → nächste Phase.
- `break_distribute` über Timeout → Rest per Zufall → `break_drink`.
- `tiebreak`-Gruppen über Limit → Gruppe beenden; alle beendet → Rangliste → `results`.

**Aufrufer:** Die TV-Ansicht ruft `tick` **jede Sekunde** auf. Alle Spieler-Clients rufen `tick` zusätzlich alle 5 s auf (Fallback, falls der TV-Laptop hängt). `tick` erhöht `version` nur, wenn sich etwas geändert hat. Zusätzlich prüfen alle Aktions-RPCs abgelaufene Fristen selbst, bevor sie handeln (z.B. `hunt_press` nach Frist → `failed`).

### 5.5 Uhrzeitversatz
`get_state` liefert `server_now`. Client misst `t0` vor und `t1` nach dem Aufruf: `offset = server_now − (t0 + t1)/2`, gleitender Mittelwert über die letzten 5 Messungen. Countdowns: `deadline − (Date.now() + offset)`.

---

## 6. Datenmodell (Supabase / Postgres)

Alle Tabellen im Schema `public`, Primärschlüssel `uuid default gen_random_uuid()`, sofern nicht anders angegeben. Zellen werden als Index `0 … N²−1` adressiert (`row = idx / N`, `col = idx % N`). Raster werden als Text der Länge N² gespeichert, `'0'` = leer.

### 6.1 Tabellen

**`games`** (öffentlich lesbar, Realtime)
| Spalte | Typ | Bemerkung |
|---|---|---|
| id | uuid PK | |
| code | text | 4 Ziffern, eindeutig unter nicht beendeten Spielen |
| phase | text | siehe §5.3, CHECK-Constraint |
| version | bigint | +1 bei jeder Änderung |
| config | jsonb | siehe §6.2 |
| trial_done | boolean | |
| round_no | int | Zähler Haupt-Sudokus |
| current_round_id | uuid | |
| main_started_at | timestamptz | Start des ersten Haupt-Sudokus (25-Min.-Limit) |
| phase_started_at | timestamptz | |
| phase_deadline | timestamptz null | für Timeouts |
| hunts_started | int | 0…35 |
| created_at | timestamptz | |

**`game_secrets`** (kein Zugriff): game_id PK, host_pin_hash.

**`players`** (kein direkter Zugriff)
id, game_id, name, color, seat_no, joined_at,
locked_until timestamptz null, err_window_started_at timestamptz null, err_window_count int,
active_hunt_id uuid null,
lines_claimed int, hunts_started int, hunts_success int, errors_total int, locks_total int,
sips_to_distribute int, sips_to_drink int, sips_given_total int, sips_received_total int,
ready boolean,
cash_cents int null, cash_submitted_at timestamptz null,
tiebreak_group int null, tiebreak_correct int, tiebreak_last_correct_at timestamptz null, tiebreak_finished_at timestamptz null,
final_rank int null, rank_by_lot boolean.
UNIQUE (game_id, name), UNIQUE (game_id, color).

**`player_secrets`** (kein Zugriff): player_id PK, token_hash.

**`puzzles`**: id, size (4/6/9), difficulty ('leicht'|'mittel'), givens text, created_at.
**`puzzle_solutions`** (kein Zugriff): puzzle_id PK, solution text.

**`rounds`**: id, game_id, kind ('trial'|'main'|'tiebreak'), round_no, puzzle_id, size, givens text, revealed text (Vorgaben + aufgedeckte Zellen), started_at, deadline, ended_at.

**`lines`**: id, round_id, game_id, line_type ('row'|'col'), idx int, status ('claimed'|'neutral'), player_id null, claimed_at, origin_cell int null (Zelle, deren Eingabe die Linie abgeschlossen hat; neutral: null), digits text. UNIQUE (round_id, line_type, idx).

**`entries`**: round_id, player_id, cell int, digit int, entered_at. PK (round_id, player_id, cell). Nur korrekte Eingaben.

**`hunts`**: id, game_id, round_id, player_id, kind ('main'|'trial'), lines_label text (z.B. «Zeile 4 + Spalte 7»), started_at, min_press_at, deadline, status ('active'|'success'|'failed'), pressed_at null.

**`sip_transfers`**: id, game_id, round_no, from_player, to_player, amount int, is_random boolean, created_at.

**`events`**: id bigserial, game_id, type text, payload jsonb, created_at. Für den Ticker («Anna löst Zeile 4», «Ben ist 20 s gesperrt», «Jagd von Cara erfolgreich»).

Indizes auf alle `game_id`/`round_id`-Fremdschlüssel.

### 6.2 `config` (Standardwerte, beim Erstellen überschreibbar für Tests/Bots)
```json
{
  "max_players": 7,
  "balloons_total": 35,
  "hunt_duration_s": 50,
  "hunt_min_press_s": 10,
  "trial_hunt_duration_s": 15,
  "trial_hunt_min_press_s": 5,
  "error_window_s": 30,
  "error_max": 3,
  "lock_s": 20,
  "round_limit_s": 480,
  "round_end_hold_s": 5,
  "game_limit_s": 1500,
  "sips_per_line": 1,
  "distribute_timeout_s": 60,
  "force_continue_after_s": 120,
  "tiebreak_limit_s": 90,
  "cash_reveal_s": 10,
  "award_min_hunts": 2,
  "difficulty": "leicht",
  "cash_max_cents": 1000,
  "coins_total_cents": 940
}
```
Alle Spielzahlen kommen **nur** aus `config` – keine Magic Numbers im SQL oder JS.

### 6.3 Spielerfarben (fest)
Rot `#E5484D`, Orange `#F76B15`, Gelb `#FFC53D`, Grün `#30A46C`, Türkis `#12A594`, Blau `#3E63DD`, Violett `#8E4EC6`, Pink `#D6409F` (nur für Tests mit 8 Spielern). Neutral: Grau `#8B8D98`. Auf dunklem Hintergrund gut lesbar; Text auf Farbflächen mit ausreichendem Kontrast.

---

## 7. Rätsel-Pool

- **Generator** `tools/generate-puzzles.mjs` (Node, ohne Abhängigkeiten), Kernlogik in `tools/sudoku-core.mjs`:
  1. Vollständige Lösung per randomisiertem Backtracking (N = 4, 6, 9; Boxen 2×2, 2×3, 3×3).
  2. Zellen in zufälliger Reihenfolge entfernen. Ein Entfernen wird nur behalten, wenn danach gilt:
     - **genau eine Lösung** (Solver zählt bis 2),
     - **nur mit Singles lösbar** (Naked Single + Hidden Single, kein Raten) → «ohne Notizen lösbar»,
     - **jede Zeile und jede Spalte hat mindestens 2 leere Zellen**.
  3. Stoppen, wenn die Ziel-Anzahl Vorgaben erreicht ist.
- Ziel-Vorgaben (Startwerte, per Bot-Simulation justieren): 9×9 leicht 38–42, 9×9 mittel 32–36, 6×6: 14–16, 4×4: 6–7.
- Menge: 30× 9×9 leicht, 15× 9×9 mittel, 10× 6×6, 10× 4×4.
- **Ausgabe:** `supabase/seed/puzzles.sql` (INSERTs in `puzzles` + `puzzle_solutions`). **Diese Datei ist in `.gitignore`** und wird von mir im Supabase SQL-Editor ausgeführt.
- Tests `tools/sudoku-core.test.mjs` (`node --test`): Eindeutigkeit, Singles-Lösbarkeit, Mindestleerstellen, Lösung gültig.
- Server wählt pro Runde zufällig ein Rätsel der passenden Grösse/Schwierigkeit, das im Spiel noch nicht verwendet wurde.

---

## 8. RPC-Schnittstelle

Alle Funktionen: `SECURITY DEFINER`, `SET search_path = public, extensions`, Rückgabe `jsonb`. Erwartbare Ablehnungen kommen als `{ok:false, reason:'…'}` (kein `raise`). `raise` nur bei Programmierfehlern.

| Funktion | Wer | Zweck |
|---|---|---|
| `create_game(p_pin text, p_config jsonb)` | TV | Spiel erstellen → `{ok, game_id, code}` |
| `host_check(p_code, p_pin)` | TV | PIN prüfen (TV-Wiederverbindung) |
| `join_game(p_code, p_name, p_color)` | Handy | Beitreten (nur Phase `lobby`) → `{ok, player_id, token}` |
| `host_rebind_player(p_code, p_pin, p_player_id)` | TV | neues Token für bestehenden Spieler → `{ok, token}` |
| `get_state(p_code, p_token default null)` | alle | Snapshot (§8.1) |
| `tick(p_code)` | alle | Zeitübergänge (§5.4) |
| `host_start_trial(p_code, p_pin)` | TV | Proberunde starten (min. 2 Spieler) |
| `host_start_main(p_code, p_pin)` | TV | Hauptspiel starten |
| `enter_digit(p_code, p_token, p_cell int, p_digit int)` | Handy | Eingabe (§8.2) |
| `hunt_press(p_code, p_token)` | Handy | «Ballon im Depot» |
| `give_sip(p_code, p_token, p_target uuid)` | Handy | 1 Shot verteilen |
| `give_sips_random(p_code, p_token)` | Handy | Rest zufällig verteilen |
| `confirm_ready(p_code, p_token)` | Handy | «Getrunken & bereit» |
| `host_force_continue(p_code, p_pin)` | TV | Pause erzwingen (erst nach `force_continue_after_s`) |
| `submit_cash(p_code, p_token, p_cents int)` | Handy | Betrag eingeben/korrigieren |
| `host_close_cashout(p_code, p_pin)` | TV | Kassensturz abschliessen → Ranking/Tiebreak |
| `server_time()` | alle | `now()` (für Smoke-Test) |

### 8.1 `get_state` – Inhalt
- `server_now`, `game` (Phase, Version, Config, Zeiten, `hunts_started`, `balloons_left`, Spielzeit, Rundenzahl)
- `round`: `kind`, `size`, `givens`, `revealed`, `started_at`, `deadline` (**nie die Lösung**)
- `lines`: alle gesperrten Linien der Runde (Typ, Index, Status, Spieler, `claimed_at`, `origin_cell`)
- `players` (öffentlich): id, Name, Farbe, Zähler, `ready`, `has_submitted_cash`, `locked_until`, aktive Jagd (Frist), Shots dieser Pause (zu verteilen/erhalten), `cash_cents` **nur ab Phase `tiebreak`/`results`**, `final_rank`, Tiebreak-Gruppe/-Fortschritt
- `hunts_active`, `sip_transfers` der aktuellen Pause, `ticker` (letzte 20 Events)
- `me` (nur mit gültigem Token): eigene Einträge der Runde, Fehlerzähler + Fensterstart, `locked_until`, aktive Jagd (`min_press_at`, `deadline`, Label), `sips_to_distribute`, `sips_to_drink` + Absender, `balloons_allowed`, `cash_cents`
- `stats` (nur Phase `results`): siehe §2.12

### 8.2 `enter_digit` – Ablauf (exakt so umsetzen)
1. Spielzeile `FOR UPDATE` sperren; Token prüfen; abgelaufene Fristen dieses Spielers bereinigen.
2. Phase muss `round_running`, `trial_running` oder `tiebreak` (Spieler in aktiver Gruppe, Gruppe nicht beendet) sein.
3. `now() < locked_until` → `{ok:false, reason:'locked', locked_until}`.
4. Aktive Jagd → `{ok:false, reason:'hunting'}`.
5. Zelle schon belegt (Vorgabe, aufgedeckt, eigene Eingabe) → `{ok:false, reason:'filled'}`.
6. **Falsch:** `errors_total++`; Fenster: falls leer oder `now() − err_window_started_at > error_window_s` → Start = now, Zähler = 1, sonst Zähler++. Zähler ≥ `error_max` → `locked_until = now() + lock_s`, `locks_total++`, Fenster zurücksetzen, Ticker-Event. → `{ok:true, result:'wrong', error_count, locked_until}`.
7. **Richtig:** Eintrag speichern. Bei `tiebreak`: Zähler/Zeit aktualisieren, bei vollständigem Raster `tiebreak_finished_at` setzen und Gruppe beenden → fertig.
8. Zeile und Spalte der Zelle prüfen: nicht gesperrt UND für diesen Spieler vollständig → beansprucht.
9. Falls beansprucht (1 oder 2 Linien):
   - `lines` einfügen (Status `claimed`, `origin_cell` = eingegebene Zelle, Ziffern aus Lösung), `rounds.revealed` aktualisieren, Ticker-Event.
   - Haupt-Sudoku: `lines_claimed += n`, `sips_to_distribute += n × sips_per_line`.
   - Jagd erzeugen, falls `hunts_started < balloons_total` (Haupt) bzw. immer (Probe, Kind `trial`, zählt nicht): `min_press_at`, `deadline` aus Config; `games.hunts_started++` und `players.hunts_started++` (nur Haupt).
   - Wurde damit die **35. Jagd** gestartet → Phase sofort `round_ending`.
10. **Neutral-Prüfung:** Jede noch nicht gesperrte Linie, deren Zellen alle in `revealed` gefüllt sind → `lines` mit Status `neutral` einfügen.
11. Alle 2N Linien gesperrt → Phase `round_ending`/`trial_ending`.
12. `version++`. Rückgabe `{ok:true, result:'correct', claimed:[…], hunt:{…}|null}`.

### 8.3 Übergang `break_drink` → weiter
Wenn alle `ready` (oder Host erzwingt): Pausen-Zähler zurücksetzen (`sips_to_drink`, `ready`). Dann:
- `hunts_started >= balloons_total` → `cashout`
- `now() − main_started_at < game_limit_s` → neue Runde (`round_no++`, neues Rätsel, `round_running`)
- sonst → `cashout`

### 8.4 Ranking (`host_close_cashout`)
Nur wenn alle Spieler `cash_submitted_at` gesetzt haben. Gruppen gleicher Beträge bilden. Einzelne → Rang direkt. Gruppen ≥ 2 → `tiebreak_group` setzen, eine `tiebreak`-Runde (6×6) mit Frist starten, Phase `tiebreak`. Nach Ende aller Gruppen: Ränge innerhalb der Gruppen gemäss §2.11 vergeben, Losentscheid falls nötig (`rank_by_lot = true`), Phase `results`.

---

## 9. Frontend

### 9.1 Struktur
```
badoku-extreme/
├─ CLAUDE.md
├─ README.md                 Setup-Anleitung (Supabase, Pages, Seed)
├─ index.html                Startseite: «TV-Ansicht» / «Mitspielen»
├─ tv.html
├─ play.html
├─ css/
│  ├─ base.css               Tokens (Farben, Abstände, Typo), Reset, Komponenten
│  ├─ tv.css
│  └─ play.css
├─ js/
│  ├─ config.js              SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (öffentlich)
│  ├─ api.js                 RPC-Wrapper, einheitliche Fehlerbehandlung
│  ├─ sync.js                Realtime-Abo auf games.version, Polling-Fallback, entprelltes get_state
│  ├─ clock.js               Server-Offset, Countdown-Helfer
│  ├─ grid.js                Rendering N×N-Raster (TV + Handy), Box-Linien für 4/6/9
│  ├─ wakelock.js            Wake Lock inkl. Neu-Anforderung bei visibilitychange
│  ├─ sound.js               WebAudio-Töne (generiert, keine Dateien)
│  ├─ qr.js                  QR als SVG via vendor/qrcode.js
│  ├─ util.js                DOM-Helfer, HTML-Escaping, localStorage mit Fallback, Verbindungsanzeige
│  ├─ tv.js                  TV-Steuerung, Tick-Schleife (1 s)
│  └─ play.js                Spieler-Steuerung, Tick-Fallback (5 s)
├─ mockups/                 klickbare Attrappe aller Bildschirme, abgenommene Vorlage
├─ vendor/
│  ├─ supabase.js            fixierte Version, Versionskommentar am Dateianfang
│  └─ qrcode.js
├─ supabase/
│  ├─ migrations/
│  │  ├─ 000_server_time.sql Smoke-Test
│  │  ├─ 001_puzzles.sql     Rätsel-Pool
│  │  ├─ 002_schema.sql
│  │  ├─ 003_security.sql    RLS, revoke/grant
│  │  ├─ 004_helpers.sql     Token/PIN, Linien-Helfer, Snapshot
│  │  ├─ 005_game_rpc.sql    RPCs der Lobby + tick
│  │  ├─ 006_realtime.sql    games in Publikation supabase_realtime
│  │  ├─ 007_round_rpc.sql   Sudoku-Runde: host_start_main, enter_digit, Rundenlimit
│  │  ├─ 008_hunt_rpc.sql    Jagd: hunt_press, Fristablauf, Ende bei der letzten Jagd
│  │  ├─ 009_break_rpc.sql   Pausen: Shots verteilen, Zufall, Trinken, bereit, erzwingen
│  │  ├─ 010_round_end_hold.sql  Fertiges Raster bleibt am Rundenende sichtbar
│  │  ├─ 011_trial_rpc.sql   Proberunde: host_start_trial, finish_trial, zurück in die Lobby
│  │  └─ 012_cashout_rpc.sql Kassensturz, Powersudoku, Rangliste, Statistik
│  ├─ tests/rules_test.sql   Szenario-Tests (raise exception bei Fehler)
│  └─ seed/                  (gitignored) puzzles.sql
├─ tools/
│  ├─ package.json           nur für bots.mjs (@supabase/supabase-js)
│  ├─ sudoku-core.mjs
│  ├─ sudoku-core.test.mjs
│  ├─ generate-puzzles.mjs
│  └─ bots.mjs
└─ .gitignore                supabase/seed/, node_modules/, .env
```
Alle Pfade **relativ** (GitHub Pages läuft unter `/badoku-extreme/`).

### 9.2 Spieleransicht (`play.html`), Mobile-first
| Phase | Anzeige |
|---|---|
| Beitritt | Code (aus `?g=` vorausgefüllt), Name, Farbwahl (belegte Farben ausgegraut) |
| Lobby | «Warte auf Start», Mitspielerliste, Hinweis Wake Lock; erster Tipp aktiviert Wake Lock |
| Sudoku | Raster (füllt Bildschirmbreite), Zahlenblock 1–N unten, Zelle antippen → Zahl tippen. Vorgaben fett, eigene Eingaben in eigener Farbe, aufgedeckte Linien eingefärbt (Spielerfarbe bzw. grau). Fehler: Zelle rot aufblitzen + Vibration, 3 Fehlerpunkte sichtbar. Sperre: Overlay mit Countdown. Kopfzeile: Rundentimer, Ballone in der Halle, eigene Linien. |
| Jagd | Vollbild grün, Text «ZEILE 4 GELÖST!», grosser Countdown, Button erst nach 10 s aktiv (Fortschritt), danach riesig. Erfolg ✔ / Zeit abgelaufen ✗, je 2 s, dann zurück. Ton + Vibration beim Start. |
| Rundenende | Fertiges Raster ohne Eingabe, solange keine Jagd läuft (§2.4); sonst «Runde beendet – warte auf laufende Jagden» |
| Verteilen | «Du hast X Shots zu verteilen», grosse Kacheln pro Mitspieler (Farbe, Name, bereits erhalten), Tippen = +1, Button «Zufall», Rest-Zähler |
| Trinken | «Du musst X Shots trinken» + Absender, Button «Getrunken & bereit» |
| Kassensturz | «Du darfst N Ballone platzen lassen», Betragseingabe (Dezimaltastatur, `inputmode="decimal"`, Komma und Punkt erlaubt), Senden, Ändern bis abgeschlossen |
| Powersudoku | 6×6-Raster, falls in einer Gruppe; sonst «Zuschauen» |
| Resultate | eigener Rang, Betrag, persönliche Statistik |

Grosse Touch-Ziele (min. 48 px), kein Zoom (`touch-action: manipulation`), keine versehentlichen Doppeltipps.

### 9.3 TV-Ansicht (`tv.html`), für 1920×1080 optimiert, gut lesbar aus 4 m
| Phase | Anzeige |
|---|---|
| Start | «Neues Spiel» (PIN setzen, Schwierigkeit wählen) oder «Verbinden» (Code + PIN) |
| Lobby | Riesiger QR-Code + Code, Spieler mit Farben, Buttons «Proberunde» / «Hauptspiel starten». Die PIN wird nur beim Erstellen oder Verbinden eingegeben, der TV merkt sie sich pro Spiel im `localStorage`, «Anderes Spiel» löscht sie. |
| Runde | Grosses Raster: nur Vorgaben + aufgedeckte Linien (farbig/grau). Seitenleiste: Spieltimer (25:00 ab Hauptstart), Rundentimer (8:00), **Ballone in der Halle**, laufende Jagden mit Countdown-Balken in Spielerfarbe, Scoreboard (Linien, erfolgreiche Jagden), Ticker |
| Pause | Matrix/Liste «wer gibt wem», Status pro Spieler (verteilt ✓ / bereit ✓), nach 120 s Button «Weiter erzwingen» |
| Kassensturz | Pro Spieler «darf N Ballone platzen lassen» + Eingabestatus ✓, Button «Kassensturz abschliessen» (aktiv, wenn alle eingegeben haben), danach Hochzähl-Animation und Summe |
| Powersudoku | Gruppen nebeneinander, Fortschrittsbalken pro Spieler, Countdown |
| Resultate | Podest Top 3, Tabelle Rang 1–7, Auszeichnungen, Statistik |

Gestaltung: dunkles Theme, eine klare Akzentfarbe, Spielerfarben als einziges «buntes» Element. Animationen kurz und deutlich (Linie gelöst: siehe §9.5). Joko-und-Klaas-Showcharakter, aber lesbar.

### 9.4 Robustheit
- Jede Ansicht ist zu jedem Zeitpunkt aus `get_state` vollständig rekonstruierbar (Neuladen = gleicher Stand).
- Verbindungsanzeige (grün/orange/rot) dezent in der Ecke.
- Buttons nach Klick bis zur Antwort deaktivieren (keine Doppelaktionen).
- Offline/Fehler einer RPC → kurze Meldung, kein Absturz, nächster Snapshot korrigiert.
- `localStorage`-Zugriffe immer in `try/catch`.

### 9.5 Aufdecken einer Linie (in der Attrappe abgenommen, Vorlage `mockups/`)
Gilt auf dem TV und auf allen Handys. Das Handy des Lösers zeigt stattdessen sofort den Jagd-Bildschirm.
- **Ballon-Platzer:** Von `origin_cell` aus erscheint auf jeder bisher verdeckten Zelle der Linie nacheinander ein Ballon in Spielerfarbe, bläst sich auf und platzt (Ring, Splitter), darunter erscheint die Ziffer. Danach leuchtet die ganze Linie kurz auf.
- **Name:** Der Name des Lösers blitzt in Spielerfarbe in der Mitte der Linie auf (ca. 1,5 s) und bleibt ganz im Raster.
- **Neutrale Linien:** nur ruhiges Einblenden in Grau, kein Name, keine Ballone.
- **Kreuzung:** Kreuzen sich zwei gelöste Linien verschiedener Besitzer, zeigt die Zelle beide Farben: Zeilenfarbe links/rechts, Spaltenfarbe oben/unten. So läuft jede Linie sichtbar durch.
- **Robustheit:** Der Effekt läuft ab dem Moment, in dem das Gerät die Linie zum ersten Mal sieht, damit er auch bei langsamer Verbindung vollständig zu sehen ist. Ein neuer Snapshot setzt ihn fort, statt ihn neu zu starten. Nach Neuladen läuft er nur, wenn die Linie laut `claimed_at` und Serverzeit gerade erst gelöst wurde.
- `prefers-reduced-motion`: nur Einblenden und Name.

---

## 10. Tests

1. **Rätsel:** `node --test tools/*.test.mjs` – Generator-Eigenschaften (§7).
2. **SQL-Szenarien:** `supabase/tests/rules_test.sql`, im SQL-Editor ausführbar, räumt danach auf. Deckt ab: Beitritt (Name/Farbe doppelt), Fehlerfenster inkl. Zurücksetzen nach 30 s und Sperre, Beanspruchen, gleichzeitige Zeile + Spalte (1 Jagd, 2 Linien), Neutral-Regel, «Pech gehabt»-Fall, Jagd zu früh / rechtzeitig / zu spät (Zeitstempel im Test direkt manipulieren), 35-Jagden-Ende, Zeitlimit-Entscheid, Shots (nicht an sich selbst, Zufall), Kassensturz-Sichtbarkeit, Tiebreak-Ranking inkl. Los.
3. **Bot-Simulation:** `node tools/bots.mjs --players 7 --speed normal` erstellt ein Spiel mit verkürzter Config (optional), lässt 7 Bots mit realistischem Tempo, Fehlerquote und Jagd-Erfolgsquote spielen, ruft `tick` auf und gibt am Ende aus: Dauer pro Runde, Linien pro Spieler, Jagden, Spielverlauf. Ziel: Vorgaben-Anzahl so justieren, dass eine Runde ca. 4–6 Min. dauert.
4. **Generalprobe:** 3–4 echte Handys (iOS + Android), Wake Lock 2 Min. prüfen.

---

## 11. Meilensteine

Nach **jedem** Meilenstein: stoppen, berichten, Testanleitung geben, auf OK warten.

| # | Inhalt | Abnahme |
|---|---|---|
| **M0** | Repo-Grundgerüst, `README.md` mit Setup-Anleitung (Supabase-Projekt, Migrationen ausführen, Publishable Key in `config.js`, GitHub Pages aktivieren), `vendor/`-Dateien, `index.html` als Smoke-Test: zeigt `server_time()`, Realtime-Status und Wake-Lock-Test | Seite läuft auf GitHub Pages, Handy zeigt Serverzeit + Realtime «verbunden» |
| **M1** | Rätsel-Generator + Tests + Seed-Datei | Tests grün, Seed im SQL-Editor ausgeführt |
| **M2** | Schema, Security, Helfer, `create_game`, `join_game`, `get_state`, `tick`-Gerüst, `sync.js`, TV-Lobby mit QR, Beitritt auf dem Handy | 3 Handys treten per QR bei, TV zeigt sie live |
| **M3** | Haupt-Sudoku: `enter_digit` komplett (Fehler, Sperre, Beanspruchen, Aufdecken, Neutral), Rundenende, Raster auf TV und Handy | Runde lässt sich zu Ende spielen, Linien erscheinen live |
| **M4** | Jagd: Erzeugung, Overlay, Button-Sperre 10 s, `hunt_press`, Fristablauf, Ballonzähler, 35-Jagden-Ende | Jagd funktioniert mit echten Handys |
| **M5** | Pausen (Verteilen, Zufall, Trinken, bereit, erzwingen), mehrere Runden, 25-Min.-Limit | Zwei Runden hintereinander mit Pause |
| **M6** | Proberunde 4×4 | Proberunde ohne Auswirkung auf Spielstand |
| **M7** | Kassensturz, Powersudoku 6×6, Ranking, Resultate, Statistik | Vollständiges Spiel von Lobby bis Rangliste |
| **M8** | SQL-Szenario-Tests, Bot-Simulation, Feinschliff (Töne, Animationen, Lesbarkeit TV) | Bot-Spiel mit 7 Spielern läuft fehlerfrei durch |

**Prioritäten bei Zeitnot** (Anlass am Samstag): M0–M5 und ein einfacher Kassensturz sind Pflicht. Proberunde (M6), Powersudoku (Fallback: Gleichstand analog klären) und Statistik-Auszeichnungen dürfen gekürzt werden – vorher mit mir abstimmen.

---

## 12. Definition of Done (gesamt)
- Ein komplettes Spiel mit 7 Handys läuft von der Lobby bis zur Rangliste ohne Moderator.
- Neuladen eines beliebigen Geräts zu jedem Zeitpunkt führt zum korrekten Zustand.
- Keine Lösung, kein Secret im Repo oder im Browser einsehbar.
- Alle Zeiten und Zahlen kommen aus `config`.
- Bot-Simulation und SQL-Tests laufen grün.
