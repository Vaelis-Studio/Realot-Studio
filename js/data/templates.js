/**
 * templates.js
 * Static catalog of project starter templates offered in the New Project modal.
 * Exposed as a global for simplicity since this launcher has no bundler.
 */
window.RealotTemplates = [
    {
        id: 'blank',
        name: 'Blank Canvas',
        icon: 'monitor',
        description: 'An empty environment optimized for pure 2D rendering and custom logic.',
        default: true
    },
    {
        id: 'platformer',
        name: 'Platformer Kit',
        icon: 'move-diagonal',
        description: 'Kinematic controller, one-way platforms, and coyote-time jump tuning baked in.',
        // Bundled real project data (js/data/templates/platformer-starter.data.js)
        // that new-project seeding applies via applySnapshot() the first
        // time this template's project is opened in the editor — see
        // editor/viewport/SceneViewport.js's loadInitialProject(). Templates
        // without a hasBundledData entry (Blank Canvas) just fall through
        // to the engine's normal blank starter scene.
        hasBundledData: true,
        // Optional banner thumbnail shown above the icon/name/description in
        // the New Project modal's template grid (see TemplateGrid.js) —
        // templates without a `thumbnail` just render the small icon tile
        // like before. 720px-wide webp (matches the project's existing
        // static-thumbnail convention, see editor/assets/script-thumb.webp).
        thumbnail: 'js/data/templates/assets/platformer-thumb.webp'
    },
    {
        id: 'topdown',
        name: 'Top-Down',
        icon: 'swords',
        description: 'Playable top-down starter: player, NPCs, collectible coins, and a lit dungeon scene.',
        // Same real-project-seeding pattern as 'platformer' above — see
        // its comment for the full explanation. Data lives in
        // js/data/templates/topdown.data.js.
        hasBundledData: true,
        thumbnail: 'js/data/templates/assets/topdown-thumb.webp'
    },
    {
        id: 'flappy-bird',
        name: 'Flappy Bird',
        icon: 'bird',
        description: 'Complete flap-to-fly clone: state machine, scoring, and juice, commented for beginners.',
        // Same real-project-seeding pattern as 'platformer' above — see
        // its comment for the full explanation.
        hasBundledData: true,
        thumbnail: 'js/data/templates/assets/flappy-bird-thumb.webp'
    },
    {
        id: 'sky-jumper',
        name: 'Sky Jumper',
        icon: 'cloud',
        description: 'Endless cloud-hopping jumper: bouncy platforms, collectible stars, climbing camera, and jump SFX.',
        // Same real-project-seeding pattern as 'platformer' above — see
        // its comment for the full explanation. Data lives in
        // js/data/templates/sky-jumper.data.js.
        hasBundledData: true,
        thumbnail: 'js/data/templates/assets/sky-jumper-thumb.webp'
    },
    {
        id: 'physics-sandbox',
        name: 'Physics Sandbox',
        icon: 'shapes',
        description: 'Rapier2D bodies, colliders, and joints pre-wired for rapid prototyping.',
        // Same real-project-seeding pattern as 'platformer' above — see
        // its comment for the full explanation.
        hasBundledData: true,
        thumbnail: 'js/data/templates/assets/physics-sandbox-thumb.webp'
    }
];
