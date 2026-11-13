# 🎡 Music Wheel

Une roue de la fortune remplie de genres musicaux. Tu la fais tourner, elle tombe sur un genre,
et Spotify joue des morceaux de ce genre pendant 15 minutes (durée réglable). À la fin, on relance.

## Mise en place (une seule fois)

1. Va sur https://developer.spotify.com/dashboard et crée une app (« Web API » + « Web Playback SDK »).
2. Dans les réglages de l'app, ajoute la **Redirect URI** : `https://cybertrist.github.io/MusicWheel/` (version en ligne) et/ou `http://127.0.0.1:8888/` (version locale)
3. Copie le **Client ID** de l'app.
4. Lance `start.bat` (ou `python -m http.server 8888 --bind 127.0.0.1`) et ouvre http://127.0.0.1:8888/
5. Colle le Client ID dans les réglages, clique « Se connecter à Spotify ».

> ⚠️ Un compte **Spotify Premium** est obligatoire pour contrôler la lecture via l'API.
> En mode développement, seuls les comptes ajoutés dans « User Management » de l'app peuvent se connecter.

## Utilisation

- Ajoute / supprime des genres à droite. Syntaxe avancée : `Libellé = terme de recherche`
  (ex : `Classique = classical`) si le nom affiché diffère du genre Spotify.
- Choisis l'appareil : « Ce navigateur » (lecteur intégré) ou n'importe quel appareil Spotify ouvert.
- Tourne la roue → la musique démarre, un minuteur compte la session, la lecture se met en pause à la fin.
- Option « Relancer la roue automatiquement » pour enchaîner les genres sans rien toucher.

## Comment ça marche

100 % front (HTML/JS), pas de serveur : auth Spotify en PKCE, recherche de morceaux via
`/search?q=genre:"..."` (avec repli sur une recherche texte), puis `PUT /me/player/play`.
