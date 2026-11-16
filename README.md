# CS2 Inventory Counter

Counts skins, stickers & co. in your CS2 inventory **and in all storage units**, and exports the result as CSV and JSON.

Storage unit contents are only available through the CS2 Game Coordinator. That is why the script logs in like a Steam client ([steam-user](https://github.com/DoctorMcKay/node-steam-user) + [globaloffensive](https://github.com/DoctorMcKay/node-globaloffensive)).

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- A Steam account with CS2
- CS2 must be **closed** on the account, otherwise Steam blocks the connection

## Installation

Open a terminal in the folder:

```
npm install
```

## Usage

```
node cs2-inventory.js                 log in with username/password + Steam Guard
node cs2-inventory.js --remember      also save a login token, next start without password/code
node cs2-inventory.js --forget        delete the saved token
node cs2-inventory.js --refresh-data  reload the item name database now
node cs2-inventory.js --help          short help
```

Username and password can optionally be passed through the environment variables `STEAM_USER` and `STEAM_PASS`.

On the first run the script downloads the item names from [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API) (approx. 40 MB) and caches them in `cache/` for 7 days.

## Output

In the terminal: an overview per location (inventory and every storage unit), counts by category, stickers by tournament and variant, sticker slabs, the 30 most common skins and the 30 most common applied stickers/patches.

Every run also creates a folder `export/<date_time>/`:

| File | Content |
|---|---|
| `stickers.csv` | stickers and sticker slabs: tournament, type, variant, count in total and per location |
| `items_grouped.csv` | all items grouped by name, count in total and per location |
| `items_individual.csv` | every single item: location, float, pattern, name tag, applied stickers, charm, item ID |
| `applied_stickers.csv` | applied stickers/patches and the items they are on |
| `items.json` | all items as JSON |

The CSV files use `;` as the separator and a comma as the decimal mark. Excel with German or most other European regional settings opens them correctly as is; with English (US/UK) settings, import them via *Data → From Text/CSV*.

## Security

- Username, password and Steam Guard code are sent to Steam only. The script does not store them.
- `--remember` creates the file `.steam-token`. Anyone who has this file can log in to the account without the password and without Steam Guard. **Treat it like a password, never share or upload it.** Delete it with `--forget`.
- `export/` contains your own inventory including item IDs.
- `.steam-token`, `export/`, `cache/` and `node_modules/` are listed in `.gitignore`. If you pass the folder on as a ZIP, remove them yourself first.

## Troubleshooting

| Message | Solution |
|---|---|
| `A game (AppID …) is currently running on this account …` | close the game in the other session, the script waits |
| `No connection to the CS2 Game Coordinator (3 min)` | CS2 is still running somewhere or the Game Coordinator is unreachable right now, try again later |
| `The saved token is invalid and has been deleted` | restart and log in with your password |
| `… items without a name` | update the name database with `--refresh-data` |
| `… only x/y items loaded` or `could not be loaded` | the affected storage unit is missing from the report in whole or in part, run the script again |

## Disclaimer

Unofficial tool, not affiliated with Valve. Use at your own risk.

## License

MIT, see [LICENSE](LICENSE).
