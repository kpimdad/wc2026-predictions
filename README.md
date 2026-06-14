# ⚽ World Cup 2026 Prediction Game

A family & friends prediction game for the FIFA World Cup 2026.
Static web app — no server, no build step. Runs on GitHub Pages. Data in Firebase Firestore.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell — all views |
| `app.js` | All logic (auth, routing, scoring) |
| `style.css` | Mobile-first dark theme |
| `firebase-config.js` | **You fill this in** |
| `matches.js` | All 104 WC 2026 fixtures |
| `manifest.json` | PWA manifest (add to home screen) |

---

## Setup — Step by Step

### 1. Create a Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it a name → disable Google Analytics (optional) → Create
3. On the project dashboard, click **Web** (</> icon) → Register app
4. Copy the `firebaseConfig` object shown

### 2. Fill in `firebase-config.js`

Open `firebase-config.js` and replace every placeholder value with your real config:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIza...",
  authDomain:        "my-project.firebaseapp.com",
  projectId:         "my-project",
  storageBucket:     "my-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123..."
};
```

### 3. Enable Firestore

1. In Firebase Console → **Build → Firestore Database**
2. Click **Create database** → choose **Start in test mode** → pick a region → Enable

### 4. Apply Security Rules

In Firestore Console → **Rules** tab, paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if true;
      allow write: if false;
    }
    match /matches/{matchId} {
      allow read: if true;
      allow write: if false;
    }
    match /predictions/{predictionId} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

> **Note:** These rules are intentionally permissive for a private family group. The `users` and `matches` collections are write-protected at the Firestore level — only you (the admin) can change them via the Firebase Console. Predictions are open because the app enforces lock times in JavaScript.

### 5. Fork & Deploy to GitHub Pages

1. Fork or push this repo to GitHub
2. Go to **Settings → Pages**
3. Under "Build and deployment", choose **Deploy from a branch**
4. Select **main** branch, **/ (root)** folder → Save
5. Your app will be live at `https://YOUR-USERNAME.github.io/REPO-NAME/`

### 6. Create Your Admin Account (First User)

You need to manually add the first user (yourself) via the Firebase Console.

1. In Firestore Console → **Data** tab → **+ Start collection**
2. Collection ID: `users`
3. Auto-generate the Document ID
4. Add these fields:

| Field | Type | Value |
|-------|------|-------|
| `nickname` | string | `Imdad` |
| `pinHash` | string | *(see PIN hash helper below)* |
| `mobile` | string | `+44 7700 000000` *(optional)* |
| `isAdmin` | boolean | `true` |
| `totalPoints` | number | `0` |
| `exactScores` | number | `0` |
| `correctResults` | number | `0` |
| `createdAt` | timestamp | *(now)* |

### 7. Generate a PIN Hash

Open the browser console on any page and run:

```js
async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
// Example: hash the PIN "1234"
hashPin("1234").then(console.log);
```

Copy the output hex string and paste it as the `pinHash` field in Firestore.

### 8. Add More Players

Once you're logged in as admin:

1. Open the app → tap **Admin** in the nav
2. Go to the **Users** tab
3. Enter nickname + 4-digit PIN → **Add User**

The app hashes the PIN before saving — raw PINs are never stored.

### 9. Share the Link

Send `https://YOUR-USERNAME.github.io/REPO-NAME/` to family and friends.
Tell each person their nickname and PIN. They tap their name in the dropdown, enter their PIN, and they're in.

---

## Match Data

All 104 matches are pre-loaded from `matches.js`:
- 72 group stage matches (Groups A–L, 12 groups × 6 matches)
- 16 Round of 32
- 8 Round of 16
- 4 Quarter-Finals
- 2 Semi-Finals
- 1 Third Place Play-off
- 1 Final

Knockout team names are placeholders (e.g. "Winner Group A"). Edit them in the Admin Panel → Matches as teams advance.

---

## Scoring

| Prediction | Points |
|-----------|--------|
| Exact scoreline | 🟡 **10 pts** |
| Correct winner or draw | 🔵 **5 pts** |
| Wrong | ⚫ **0 pts** |

Points are calculated when the admin enters the result. User totals update automatically.

---

## Admin: Entering Results

1. Log in with your admin account
2. Tap **Admin** → **Matches**
3. Find the match, enter Team A and Team B scores
4. Click **Save Result** — this scores all predictions and updates the leaderboard

---

## Resetting / Correcting a Result

If you entered a wrong result:

1. Admin → Matches → enter the correct scores → Save Result again
2. OR Admin → Recalculate → select the match → Recalculate This Match

---

## PWA — Add to Home Screen

On iPhone (Safari): Share → **Add to Home Screen**
On Android (Chrome): Menu → **Add to Home Screen**

The app opens fullscreen with no browser chrome.

---

## Firestore Data Model

```
users/{auto-id}
  nickname        string
  pinHash         string   SHA-256 hex of their PIN
  mobile          string   optional
  isAdmin         boolean
  totalPoints     number
  exactScores     number
  correctResults  number
  createdAt       timestamp

matches/{matchId}   e.g. "m001"
  status          "upcoming" | "locked" | "completed"
  resultA         number | null
  resultB         number | null
  (other fields live in matches.js locally)

predictions/{userId}_{matchId}
  userId          string
  matchId         string
  predictedA      number
  predictedB      number
  submittedAt     timestamp
  updatedAt       timestamp
  pointsAwarded   number | null
```

---

## Troubleshooting

**"Loading…" never goes away on the login screen**
→ Check `firebase-config.js` has real values, not placeholders.
→ Check Firestore is enabled in your Firebase project.

**PIN not working**
→ Ensure the `pinHash` field in Firestore was generated with the exact PIN (including no spaces).

**Scores not saving**
→ Check Firestore rules allow writes to `predictions`.

**Admin panel not showing**
→ Your user document must have `isAdmin: true` (boolean, not string).
