# ESNAP 1.0 — Emulator Snapshot Format

ESNAP je platformově a strojově nezávislý kontejner pro stav emulovaného
počítače. Stejný soubor má být možné používat ve webulátoru, picoM8 i emulátoru
na Raspberry Pi. Vícebajtová čísla jsou vždy little-endian.

## Přípona a identifikace

- přípona: `.esnap`
- magic: osm bajtů `EMUSNAP\0`
- MIME: `application/x-emulator-snapshot`

## Hlavička souboru (32 bajtů)

| Offset | Typ | Význam |
|---:|---|---|
| 0 | 8 B | `EMUSNAP\0` |
| 8 | u16 | hlavní verze |
| 10 | u16 | vedlejší verze |
| 12 | u16 | délka hlavičky souboru, v1 = 32 |
| 14 | u16 | délka hlavičky bloku, v1 = 24 |
| 16 | u32 | příznaky souboru |
| 20 | u32 | počet bloků |
| 24 | u32 | celková délka souboru |
| 28 | u32 | CRC32 všeho od offsetu 32 do konce |

## Hlavička bloku (24 bajtů)

| Offset | Typ | Význam |
|---:|---|---|
| 0 | 4 B | ASCII typ bloku |
| 4 | u16 | instance komponenty |
| 6 | u16 | verze schématu komponenty |
| 8 | u16 | kódování: 0 = raw, 1 = UTF-8 JSON |
| 10 | u16 | flags: bit 0 required, bit 1 embedded media |
| 12 | u32 | uložená délka |
| 16 | u32 | délka po rozbalení |
| 20 | u32 | CRC32 dat bloku |

ESNAP 1.0 nekomprimuje, takže obě délky musejí být stejné. Implementace smí
přeskočit neznámý nepovinný blok. Neznámý blok s příznakem `required` musí
odmítnout dříve, než změní stav běžícího stroje.

## Ondra SPO 186, schéma 1

| Blok | Kódování | Obsah |
|---|---|---|
| `SYS ` | raw | povinné `machineId` a varianta bez potřeby JSON parseru |
| `META` | JSON | nepovinné jméno, čas vytvoření a údaje emulátoru |
| `TIME` | raw | u64 master T-states, u64 počet snímků |
| `CPU ` | raw | obecná CPU obálka a stav konkrétní architektury |
| `MACH` | raw | porty a machine-specific latch stav |
| `RAM ` | raw | 65 536 bajtů RAM |
| `ROM ` | raw | 16 384 bajtů vložené ROM |
| `PSG ` | raw | stav SN76489, pokud je Melodik aktivní |
| `EXEC` | raw | doporučení UI: spuštěno/pozastaveno |

`SYS ` začíná délkou `machineId` (u16), délkou varianty (u16) a pokračuje
oběma řetězci v UTF-8. Malá implementace na Pico tak pozná cílový stroj bez
JSON knihovny; celý nepovinný blok `META` může přeskočit.

`CPU ` používá číslo instance z hlavičky bloku, takže jeden stroj může mít více
procesorů. Payload začíná společnou osmibajtovou obálkou:

| Offset | Typ | Význam |
|---:|---|---|
| 0 | 4 B | identifikátor architektury |
| 4 | u16 | verze stavu konkrétního procesoru |
| 6 | u16 | CPU flags, ve verzi 1 nulové |

Definované identifikátory architektur:

| ID | Procesor |
|---|---|
| `Z80 ` | Zilog Z80 |
| `8080` | Intel 8080 |
| `6502` | MOS Technology 6502 |
| `68K ` | Motorola 68000 |

Ondra používá `CPU / instance 0`, architekturu `Z80 ` a verzi stavu 1. Za
osmibajtovou obálkou následuje 32 bajtů: hlavní a alternativní osmibitové
registry včetně zabaleného F/F', IX, IY, SP, PC, I, R, IM, řídicí příznaky a
interní čítač právě prováděné instrukce. Celý blok Ondry má tedy 40 bajtů.

`PSG ` ukládá pouze skutečný obnovitelný stav: osm registrů, latched register,
tři fáze tónů, fázi šumu, LFSR a diagnostické počítadlo zápisů. Fáze jsou u32
fixed-point, kde celý rozsah 0…2^32 představuje jednu periodu. Takt čipu ani
odvozené frekvence a hlasitosti se neukládají; patří ke konfiguraci stroje.

Fyzicky stisknuté klávesy, AudioContext, canvas, GPIO a otevřené hostitelské
soubory nejsou stav emulovaného hardwaru a do ESNAP nepatří.
