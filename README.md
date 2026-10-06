# Ondra SPO 186 — webový emulátor (RC1 candidate)

Webový emulátor československého osmibitového počítače Ondra SPO 186. Ke spuštění stačí moderní prohlížeč; aplikace nemá serverovou část ani externí závislosti.

## Spuštění

Pro přednastavené ROM je vhodné spustit adresář přes jednoduchý lokální HTTP server, protože prohlížeče obvykle nepovolí jejich načtení přes `file://`:

```sh
python3 -m http.server 8000
```

Potom otevřete `http://localhost:8000`. Vlastní ROM lze vybrat i při přímém otevření `index.html`.

### Spuštění s parametry

ROM a program lze předat v URL:

```
http://localhost:8000/?ROM=Ondra_ViLi_v25&BIN=IJChZ
```

- `ROM` — název sady v `roms/` bez přípony; načtou se `<ROM>_a.rom` a `<ROM>_b.rom`.
- `BIN` — soubor v `bins/`; pokud název nemá příponu, doplní se `.bin`.
  Program se zavede do RAM asi 2 s po startu ROM (aby ji ROM při inicializaci nepřepsala) a spustí se od své startovací adresy.

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
- uložení a obnovení samostatného snapshotu `.osn` včetně CPU, RAM, ROM, videa a zvuku;
- reset, pauzu, NMI a jednoduchý debug panel.

Součástí balíčku jsou předvolby Basic EXP V5, Ondra PLUS, Tesla V5 a ViLi 2.5/2.7.

## Co zatím neumí

- načítání kazet TAP, CSW a WAV;
- tiskárnu a síťové propojení;
- fyzický gamepad přes Gamepad API.

## Snapshoty

Tlačítko **Uložit stav** stáhne snapshot ve formátu `.osn`. Soubor obsahuje registry Z80, celou RAM, použitou ROM, stránkování, stav videa, interní zvuk a kompletní stav SN76489 včetně šumového generátoru. Je proto přenositelný a při pozdějším načtení nepotřebuje původní ROM soubory.

Při načítání se nejdřív ověří identifikace formátu, verze, velikosti všech částí a CRC32. Neplatný nebo poškozený soubor stav běžícího stroje nezmění. Fyzicky stisknuté klávesy se záměrně neobnovují.

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
- `ondra.js` — paměť, periferie, video, zvuk, klávesnice a hlavní smyčka
- `Z80.js` — CPU jádro DrGoldfire/Z80.js
- `SN76489.js` — emulace zvukového čipu Melodik
- `roms/` — přednastavené obrazy EPROM
- `bins/` — BIN programy pro spuštění parametrem `BIN`

## Licence

Kód webulátoru: MIT. CPU jádro Z80.js: MIT (Molly Howell / DrGoldfire). JOndra, který posloužil jako technická reference, je licencován GPL-3.0.
