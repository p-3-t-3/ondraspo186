# Ondra SPO 186 — webový emulátor (RC1 candidate)

Webový emulátor československého osmibitového počítače Ondra SPO 186. Ke spuštění stačí moderní prohlížeč; aplikace nemá serverovou část ani externí závislosti.

## Spuštění

Pro přednastavené ROM je vhodné spustit adresář přes jednoduchý lokální HTTP server, protože prohlížeče obvykle nepovolí jejich načtení přes `file://`:

```sh
python3 -m http.server 8000
```

Potom otevřete `http://localhost:8000`. Vlastní ROM lze vybrat i při přímém otevření `index.html`.

### Spuštění s parametry

ROM, program a kazetu lze předat v URL:

```
http://localhost:8000/?ROM=Ondra_ViLi_v25&BIN=IJChZ
http://localhost:8000/?ROM=Ondra_ViLi_v27&TAP=jmeno
```

- `ROM` — název sady v `roms/` bez přípony; načtou se `<ROM>_a.rom` a `<ROM>_b.rom`.
- `BIN` — soubor v `bins/`; pokud název nemá příponu, doplní se `.bin`.
  Program se zavede do RAM asi 2 s po startu ROM (aby ji ROM při inicializaci nepřepsala) a spustí se od své startovací adresy.
- `TAP` — kazeta v `tapes/`; pokud název nemá příponu, doplní se `.tap`.
  Kazeta se po startu ROM vloží do šachty a čeká na motor; nahrávání spustíte v ROM (ViLi: klávesa po startu). Bez `ROM` kazeta jen čeká v šachtě, než ROM vyberete.

Názvy parametrů nerozlišují velikost písmen, hodnoty (názvy souborů) ano. Povolené jsou jen znaky `A–Z a–z 0–9 _ . -`.

## Co emulátor umí

- procesor Z80 a přerušení INT/NMI;
- hardwarové časování obrazu: VRAM se zachytí 5120 T po INT a obrazová DMA
  zkracuje příděl Z80 podle počtu aktivních řádků;
- 64KB paměť, ROM/RAM stránkování a dvě EPROM patice;
- EPROM obrazy o velikosti 2, 4 nebo 8 KB v každé patici, včetně hardwarového zrcadlení menších čipů;
- programovatelné černobílé video Ondry s prokládaným adresováním VRAM;
- klávesnicovou matici, kurzorové klávesy, přeřazovače a joystick na numerické klávesnici;
- responzivní dotykovou klávesnici pro mobil a tablet na výšku, včetně
  zamykatelných přeřazovačů SHIFT, SYM, 0–9, ČS a CTRL;
- obě LED, interní zvuk a kazetový výstup;
- Melodik se zvukovým čipem SN76489;
- načtení víceblokového BIN souboru přímo do RAM;
- nahrávání z kazety ve formátu TAP přes vstup magnetofonu, řízené motorem;
- uložení a obnovení přenositelného snapshotu `.esnap` včetně CPU, RAM, ROM, videa a zvuku;
- reset, pauzu, NMI, vypnutí zvuku a jednoduchý debug panel;
- volbu barvy obrazu (bílá, zelený fosfor, jantar) a scanlines vykreslované v celých fyzických pixelech, takže zůstávají ostré i při škálování Windows 125 %/150 % a zoomu prohlížeče;
- celou obrazovku (tlačítko nebo dvojklik na obraz);
- přetažení ROM, BIN, kazety `.tap` nebo snapshotu `.esnap` myší na obrazovku.

Vzhled je sjednocený s webulátorem PMD 85: vlevo obrazovka, vpravo ovládací panel s předvolbami ROM, paticemi EPROM, programem a kazetou.

Součástí balíčku jsou předvolby Basic EXP V5, Ondra PLUS, Tesla V5 a ViLi 2.5/2.7.

## Co zatím neumí

- ukládání na kazetu a kazety ve formátech CSW a WAV;
- tiskárnu a síťové propojení;
- fyzický gamepad přes Gamepad API.

## Snapshoty

Tlačítko **Uložit stav** stáhne snapshot ve formátu `.esnap` (ESNAP 1.0). Soubor obsahuje registry Z80, společnou časovou osu v T-stavech, celou RAM, použitou ROM, stránkování, stav videa, interní zvuk a obnovitelný stav SN76489 včetně fází a šumového LFSR. Je proto samostatný a při pozdějším načtení nepotřebuje původní ROM soubory.

ESNAP je společný strojově i hostitelsky nezávislý kontejner určený také pro picoM8 a emulátory na Raspberry Pi. Stav je rozdělen do samostatných bloků `SYS`, `META`, `TIME`, `CPU`, `MACH`, `RAM`, `ROM`, `PSG` a `EXEC`. Povinný binární `SYS` dovolí i malé implementaci poznat stroj bez JSON parseru. Obecný blok `CPU` obsahuje identifikátor architektury (`Z80`, `8080`, `6502`, `68K`) a podporuje více instancí. Každý blok i celý payload mají vlastní CRC32. Přesný popis je v `ESNAP_FORMAT.md`.

Při načítání se nejdřív ověří identifikace, verze kontejneru, všechny povinné bloky, jejich schémata, délky a kontrolní součty. Teprve potom se změní stav stroje. Neplatný nebo poškozený soubor stav běžícího stroje nezmění. Fyzicky stisknuté klávesy se záměrně neobnovují. Starý formát `.osn` se nepodporuje.

## Kazeta TAP

Tlačítkem pro vložení v šachtě **KAZETA** (nebo přetažením souboru `.tap` na obrazovku) se kazeta vloží a přetočí na začátek. Páska se točí, jen když Ondra sepne relé motoru magnetofonu (bit 4 portu 0Ah). Program tedy stačí spustit nahráváním v ROM, například v ViLi stiskem klávesy po startu. Šachta ukazuje, zda kazeta čeká na motor, hraje (s průběhem v procentech), nebo je dohraná. ▶ ji přetočí znovu na začátek, ⏏ ji vysune. Reset a volba ROM vloženou kazetu přetočí na začátek. Signál pásky je slyšet v reproduktoru.

Signál je bit po bitu shodný s přehrávačem picoM8: každý blok TAP má úvodní pauzu, pilotní tón, synchronizační bajt `7Fh`, 25bajtovou hlavičku (`H`…`D`), druhý pilot a datový blok (`D`, data, kontrolní součet). Bajt má 9 bitů a každý bit tvoří dvě půlvlny po 407 T. Páska běží reálnou rychlostí i v době, kdy procesor stojí kvůli obrazové DMA. Vstup magnetofonu je bit 7 při čtení 0xE000–0xFFFF.

Formát TAP odpovídá nahrávací rutině ViLi; monitor Tesla V5 používá jiný formát záznamu. ESNAP schéma 1 neobsahuje polohu pásky, proto obnovení snapshotu přehrávání zastaví.

## Ovládání klávesnice

| PC klávesa | Ondra |
|---|---|
| levý Shift | SHIFT |
| pravý Shift | NUMBERS |
| levý Alt | SYMBOLS |
| pravý Alt / Caps Lock | ČS |
| Ctrl | CTRL |
| šipky / Backspace | kurzorové klávesy |
| numerické 2, 4, 6, 8, 0 | joystick |

## Hlavní technické parametry

- CPU: Z80, 2 MHz
- obraz: 320 × 256 px, 1 bpp
- obnovování: 50 Hz
- Melodik: SN76489, krystal 4 MHz
- ROM: `$0000–$3FFF` při MP1=0
- RAM: celý adresní prostor podle stránkování
- VRAM: `$D800–$FFFF`
- klávesnice: paměťově mapované vstupy `$E000–$E009` při MP0=1

## Soubory

- `index.html` — uživatelské rozhraní a ROM loader
- `ESnap.js` — obecný kontejner ESNAP 1.0
- `ESNAP_FORMAT.md` — binární specifikace formátu a schématu Ondry
- `ondra.js` — paměť, periferie, video, zvuk, klávesnice a hlavní smyčka
- `Z80.js` — CPU jádro DrGoldfire/Z80.js
- `SN76489.js` — emulace zvukového čipu Melodik
- `roms/` — přednastavené obrazy EPROM
- `bins/` — BIN programy pro spuštění parametrem `BIN`
- `tapes/` — kazety TAP pro parametr `TAP`
- `tests/` — kontrola kontejneru, CRC a úplného snapshot round-tripu

Testy formátu lze spustit v Node.js:

```sh
node tests/esnap.test.js
node tests/ondra-esnap-roundtrip.test.js
```

## Licence

Kód webulátoru: MIT. CPU jádro Z80.js: MIT (Molly Howell / DrGoldfire). JOndra, který posloužil jako technická reference, je licencován GPL-3.0.
