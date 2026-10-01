# MvM Popfile Creator: Medallium

Heavyily editted version of Consulcast Gaming's MVM Popfile Creator. Though this definitely has AI in it, this is mainly just for me, as there is not really any good way to easily make MVM popfiles (mvm.tf has not gotten an update in literally years).

4. Open http://localhost:5173 in your browser

## Build as Desktop App (.exe)

### Option A: Portable .exe (recommended)

```
npm install
npm run package
```

This creates a portable .exe in the `release` folder. No installation needed — just double-click to run.

### Option B: Run with Electron (no packaging)

```
npm install
npm run electron-dev
```

This builds the app and opens it in an Electron window directly.
\
Open `dist/index.html` directly in your browser. You can make a desktop shortcut to this file.

## Troubleshooting

- If `npm install` fails, try deleting `node_modules` and `package-lock.json`, then run `npm install` again
- If Electron packaging fails, make sure you're on Windows and try `npx electron-builder --win`

## How to Use the .pop File

1. Export your mission using the .pop button
2. Place the file in: `tf/scripts/population/`
3. In TF2, open console and type: `map <mapname>` then `tf_mvm_popfile <filename>`

- For public testing check out potato.tf

## Features

- **Settings** — Map name, starting currency, respawn time, difficulty
- **Missions** — Sentry busters, spies, snipers, engineers with cooldowns and wave ranges
- **Bot Creator** — Build custom bot templates with items, CharacterAttributes, ItemAttributes
- **Waves** — Unlimited waves with Single/Squad/RandomChoice/Tank wavespawns
- **All Valve templates** — Verified against robot_standard.pop, robot_giant.pop, robot_gatebot.pop
- **Editable previews** — Auto-generated code you can hand-edit for full control
- **Save/Load Functionality** — Will save your popfile as a json that can be loaded later
- **Light/Dark mode**
- Release includes a feature that can fix certain broken valve templates. Currently only used for fixing non-gatebot Heal-on-Kill Heavy, may remove it if unpopular or not necessary

## To-Do

- Possibly add syntax highlighting to the free-text boxes
- Improve bot template creation by turning fields for attributes into exhaustive drop-downs
- Fix any broken icon matches with bots
- Possibly add custom icon support (? need to read VTFs to make the feature more useful, otherwise users just put their custom icons as pngs into the program) 
- UI could probably use work
- Improve relationship between editable preview of bot templates and wavespawns and their GUI counterparts
- make it skip saving as json and save as pop directly, create a popfile parser for existing pops (Deal with issue of plugin-only keyvalues?)
