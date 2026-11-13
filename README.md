# Music Wheel

Une roue de la fortune remplie de genres musicaux. Tu la fais tourner, elle tombe sur un genre,
et Spotify joue des morceaux de ce genre pendant 15 minutes (durée réglable). À la fin, on relance.

## Mise en place (une seule fois)

1. Va sur https://developer.spotify.com/dashboard et crée une app (« Web API » + « Web Playback SDK »).
2. Dans les réglages de l'app, ajoute la **Redirect URI** : `https://cybertrist.github.io/MusicWheel/` (version en ligne) et/ou `http://127.0.0.1:8888/` (version locale)
3. Le **Client ID** de l'app se règle dans `DEFAULT_CLIENT_ID` en haut de `app.js`.
4. Lance `start.bat` (ou `python -m http.server 8888 --bind 127.0.0.1`) et ouvre http://127.0.0.1:8888/
5. Clique « Se connecter à Spotify ».

> Attention : un compte **Spotify Premium** est obligatoire pour contrôler la lecture via l'API.
> En mode développement, seuls les comptes ajoutés dans « User Management » de l'app peuvent se connecter.

## Utilisation

- Ajoute / supprime des genres à droite. Syntaxe avancée : `Libellé = terme de recherche`
  (ex : `Classique = classical`) si le nom affiché diffère du genre Spotify.
- Choisis l'appareil : « Ce navigateur » (lecteur intégré) ou n'importe quel appareil Spotify ouvert.
- Tourne la roue → la musique démarre, un minuteur compte la session, la lecture se met en pause à la fin.
- Option « Relancer la roue automatiquement » pour enchaîner les genres sans rien toucher.
- Mode « Retirer le genre de la roue une fois joué » : la roue se vide au fil des sessions puis se remplit à nouveau.
- Fin du chrono : explosion plein écran, puis la roue se relance (si l'option est cochée). Raccourci : `Espace` pour tourner.
- Mise à jour à distance : la page vérifie toutes les 30 s si une nouvelle version est en ligne et se recharge toute seule
  (immédiatement si rien ne joue, sinon au prochain tirage de la roue, puis la roue tourne toute seule).
- Chat en direct : scanne le QR code affiché à l'écran (ou ouvre la page avec `?chat`) pour écrire depuis ton téléphone.
  Les messages passent dans le bandeau du bas et en bulles, façon télé. Relais : [ntfy.sh](https://ntfy.sh), sans compte.
- Modération : la page `?admin` permet de supprimer un message ou de vider tout le chat sur tous les écrans.
- Les paroles du morceau en cours s'affichent à gauche (synchronisées quand c'est possible), via [LRCLIB](https://lrclib.net).

## Comment ça marche

100 % front (HTML/JS), pas de serveur : auth Spotify en PKCE, recherche de morceaux via
`/search?q=genre:"..."` (avec repli sur une recherche texte), puis `PUT /me/player/play`.
