/* Original inline SVG diagrams for the concept guide.
 *
 * Inline and hand-authored rather than images: no licensing question, no extra
 * requests, they scale to any screen, and they inherit the theme's colours so
 * they work in light and dark without a second asset. Every diagram is
 * labelled in text as well as drawn, so nothing depends on colour alone.
 *
 * A section opts in with a marker line in its body:  [[diagram:wave]]
 */

window.DIAGRAMS = {

  wave: {
    title: "Anatomy of a wave",
    svg: `<svg viewBox="0 0 400 180" role="img" aria-label="A transverse wave showing crest, trough, wavelength and amplitude">
      <line x1="20" y1="90" x2="380" y2="90" class="d-axis" stroke-dasharray="4 4"/>
      <text x="24" y="84" class="d-lbl">rest position</text>
      <path d="M20 90 Q65 20 110 90 T200 90 T290 90 T380 90" class="d-line"/>
      <line x1="65" y1="90" x2="65" y2="47" class="d-dim"/>
      <text x="70" y="60" class="d-lbl">amplitude</text>
      <text x="52" y="38" class="d-lbl d-key">crest</text>
      <text x="98" y="145" class="d-lbl d-key">trough</text>
      <line x1="65" y1="26" x2="155" y2="26" class="d-dim"/>
      <line x1="65" y1="20" x2="65" y2="32" class="d-dim"/>
      <line x1="155" y1="20" x2="155" y2="32" class="d-dim"/>
      <text x="80" y="18" class="d-lbl">wavelength</text>
    </svg>`,
    caption: "Amplitude is measured from the rest position, not from crest to trough. Wavelength is one full cycle, crest to crest or trough to trough.",
  },

  emspectrum: {
    title: "The electromagnetic spectrum",
    svg: `<svg viewBox="0 0 400 150" role="img" aria-label="Electromagnetic spectrum from radio waves to gamma rays">
      <defs><linearGradient id="emg" x1="0" x2="1">
        <stop offset="0" stop-color="#c0392b"/><stop offset="0.45" stop-color="#e67e22"/>
        <stop offset="0.6" stop-color="#f1c40f"/><stop offset="0.72" stop-color="#27ae60"/>
        <stop offset="0.85" stop-color="#2980b9"/><stop offset="1" stop-color="#8e44ad"/>
      </linearGradient></defs>
      <rect x="20" y="40" width="360" height="26" rx="4" fill="url(#emg)"/>
      ${["Radio", "Micro", "IR", "Vis", "UV", "X-ray", "Gamma"].map((t, i) =>
        `<text x="${28 + i * 52}" y="82" class="d-lbl">${t}</text>`).join("")}
      <line x1="20" y1="100" x2="380" y2="100" class="d-axis"/>
      <text x="20" y="120" class="d-lbl">long wavelength</text>
      <text x="380" y="120" class="d-lbl" text-anchor="end">short wavelength</text>
      <text x="20" y="136" class="d-lbl d-key">low energy</text>
      <text x="380" y="136" class="d-lbl d-key" text-anchor="end">high energy</text>
      <text x="200" y="28" class="d-lbl d-key" text-anchor="middle">frequency and energy increase this way &#8594;</text>
    </svg>`,
    caption: "Order: radio, microwave, infrared, visible, ultraviolet, X-ray, gamma. As wavelength gets shorter, frequency and energy both go up.",
  },

  earthlayers: {
    title: "Earth's interior",
    // Leader lines run straight out from the vertical radius, so they stay
    // parallel and never cross. An earlier version fanned them from the
    // centre and they tangled.
    svg: `<svg viewBox="0 0 400 210" role="img" aria-label="Cross section of Earth showing crust, mantle, outer core and inner core">
      <circle cx="110" cy="112" r="88" class="d-fill-3"/>
      <circle cx="110" cy="112" r="58" class="d-fill-2"/>
      <circle cx="110" cy="112" r="28" class="d-fill-1"/>
      <circle cx="110" cy="112" r="88" class="d-line" fill="none"/>
      <line x1="110" y1="100" x2="228" y2="100" class="d-dim"/>
      <line x1="110" y1="70" x2="228" y2="70" class="d-dim"/>
      <line x1="110" y1="40" x2="228" y2="40" class="d-dim"/>
      <line x1="110" y1="26" x2="228" y2="16" class="d-dim"/>
      <text x="234" y="103" class="d-lbl d-key">Inner core</text>
      <text x="234" y="115" class="d-lbl">solid iron and nickel</text>
      <text x="234" y="73" class="d-lbl d-key">Outer core</text>
      <text x="234" y="85" class="d-lbl">liquid, makes the field</text>
      <text x="234" y="43" class="d-lbl d-key">Mantle</text>
      <text x="234" y="55" class="d-lbl">solid rock, flows slowly</text>
      <text x="234" y="19" class="d-lbl d-key">Crust</text>
      <text x="234" y="31" class="d-lbl">thin and brittle</text>
      <text x="110" y="207" class="d-lbl" text-anchor="middle">not to scale</text>
    </svg>`,
    caption: "The inner core is hotter than the outer core but stays solid, because the pressure there is enormous.",
  },

  boundaries: {
    title: "The three plate boundaries",
    svg: `<svg viewBox="0 0 400 180" role="img" aria-label="Convergent, divergent and transform plate boundaries">
      <g>
        <rect x="14" y="40" width="48" height="26" rx="3" class="d-fill-2"/>
        <rect x="66" y="40" width="48" height="26" rx="3" class="d-fill-3"/>
        <path d="M52 34 h-22 M52 34 l-6 -5 M52 34 l-6 5" class="d-arrow"/>
        <path d="M76 34 h22 M76 34 l6 -5 M76 34 l6 5" class="d-arrow"/>
        <text x="64" y="88" class="d-lbl d-key" text-anchor="middle">Convergent</text>
        <text x="64" y="104" class="d-lbl" text-anchor="middle">plates collide</text>
        <text x="64" y="118" class="d-lbl" text-anchor="middle">mountains, trenches,</text>
        <text x="64" y="132" class="d-lbl" text-anchor="middle">subduction, volcanoes</text>
      </g>
      <g>
        <rect x="148" y="40" width="42" height="26" rx="3" class="d-fill-2"/>
        <rect x="210" y="40" width="42" height="26" rx="3" class="d-fill-3"/>
        <path d="M172 34 h-22 M172 34 l-6 -5 M172 34 l-6 5" class="d-arrow"/>
        <path d="M228 34 h22 M228 34 l6 -5 M228 34 l6 5" class="d-arrow"/>
        <text x="200" y="88" class="d-lbl d-key" text-anchor="middle">Divergent</text>
        <text x="200" y="104" class="d-lbl" text-anchor="middle">plates separate</text>
        <text x="200" y="118" class="d-lbl" text-anchor="middle">new crust, rift valleys,</text>
        <text x="200" y="132" class="d-lbl" text-anchor="middle">mid-ocean ridges</text>
      </g>
      <g>
        <rect x="286" y="34" width="96" height="16" rx="3" class="d-fill-2"/>
        <rect x="286" y="54" width="96" height="16" rx="3" class="d-fill-3"/>
        <path d="M300 26 h30 M330 26 l-6 -5 M330 26 l-6 5" class="d-arrow"/>
        <path d="M368 78 h-30 M338 78 l6 -5 M338 78 l6 5" class="d-arrow"/>
        <text x="334" y="88" class="d-lbl d-key" text-anchor="middle">Transform</text>
        <text x="334" y="104" class="d-lbl" text-anchor="middle">plates slide past</text>
        <text x="334" y="118" class="d-lbl" text-anchor="middle">earthquakes,</text>
        <text x="334" y="132" class="d-lbl" text-anchor="middle">no new crust</text>
      </g>
    </svg>`,
    caption: "Transform boundaries make earthquakes but neither create nor destroy crust. That is the distinction most often tested.",
  },

  circuits: {
    title: "Series and parallel circuits",
    svg: `<svg viewBox="0 0 400 170" role="img" aria-label="A series circuit and a parallel circuit compared">
      <g>
        <text x="90" y="18" class="d-lbl d-key" text-anchor="middle">Series</text>
        <path d="M30 40 h120 v70 h-120 z" class="d-line" fill="none"/>
        <rect x="22" y="62" width="16" height="26" class="d-fill-1"/>
        <text x="14" y="105" class="d-lbl">battery</text>
        <circle cx="70" cy="40" r="9" class="d-fill-3"/>
        <circle cx="115" cy="40" r="9" class="d-fill-3"/>
        <text x="90" y="132" class="d-lbl" text-anchor="middle">one path</text>
        <text x="90" y="146" class="d-lbl" text-anchor="middle">remove one, all go out</text>
      </g>
      <g>
        <text x="300" y="18" class="d-lbl d-key" text-anchor="middle">Parallel</text>
        <path d="M240 40 h120 v70 h-120 z" class="d-line" fill="none"/>
        <path d="M280 40 v70 M330 40 v70" class="d-line"/>
        <rect x="232" y="62" width="16" height="26" class="d-fill-1"/>
        <circle cx="280" cy="75" r="9" class="d-fill-3"/>
        <circle cx="330" cy="75" r="9" class="d-fill-3"/>
        <text x="300" y="132" class="d-lbl" text-anchor="middle">separate branches</text>
        <text x="300" y="146" class="d-lbl" text-anchor="middle">remove one, others stay lit</text>
      </g>
    </svg>`,
    caption: "House wiring is parallel, which is why one blown bulb does not darken the room. Adding branches in parallel lowers total resistance.",
  },

  pyramid: {
    title: "Energy pyramid and the 10 percent rule",
    svg: `<svg viewBox="0 0 400 190" role="img" aria-label="Energy pyramid from producers to tertiary consumers losing 90 percent at each level">
      <polygon points="200,20 236,60 164,60" class="d-fill-1"/>
      <polygon points="164,62 236,62 258,102 142,102" class="d-fill-2"/>
      <polygon points="142,104 258,104 280,144 120,144" class="d-fill-3"/>
      <polygon points="120,146 280,146 302,184 98,184" class="d-fill-4"/>
      <text x="296" y="48" class="d-lbl d-key">Tertiary</text>
      <text x="296" y="60" class="d-lbl">0.1% of energy</text>
      <text x="296" y="92" class="d-lbl d-key">Secondary</text>
      <text x="296" y="104" class="d-lbl">1%</text>
      <text x="296" y="134" class="d-lbl d-key">Primary consumers</text>
      <text x="296" y="146" class="d-lbl">10%</text>
      <text x="296" y="176" class="d-lbl d-key">Producers</text>
      <text x="296" y="188" class="d-lbl">100%</text>
      <text x="20" y="16" class="d-lbl">90% lost as heat at each step</text>
    </svg>`,
    caption: "Only about 10 percent of the energy at one level reaches the next. That is why food chains rarely run past four or five links.",
  },

  moon: {
    title: "The eight moon phases",
    svg: `<svg viewBox="0 0 400 130" role="img" aria-label="The eight phases of the moon in order">
      <defs><clipPath id="mc"><circle cx="0" cy="0" r="18"/></clipPath></defs>
      ${[
        ["New", 0], ["Waxing crescent", 0.25], ["First quarter", 0.5], ["Waxing gibbous", 0.75],
        ["Full", 1], ["Waning gibbous", 0.75], ["Third quarter", 0.5], ["Waning crescent", 0.25],
      ].map(([label, lit], i) => {
        const x = 30 + i * 48, y = 45;
        const waning = i > 4;
        // lit fraction drawn as an ellipse mask, flipped after full
        const rx = Math.abs(lit - 0.5) * 36;
        const side = lit >= 0.5 ? 1 : -1;
        return `<g transform="translate(${x},${y})">
          <circle cx="0" cy="0" r="18" class="d-moon-dark"/>
          ${lit === 1 ? `<circle cx="0" cy="0" r="18" class="d-moon-lit"/>` :
            lit === 0 ? "" :
            `<g clip-path="url(#mc)">
               <rect x="${waning ? -18 : 0}" y="-18" width="18" height="36" class="d-moon-lit"/>
               <ellipse cx="0" cy="0" rx="${rx}" ry="18" class="${side > 0 ? "d-moon-lit" : "d-moon-dark"}"/>
             </g>`}
          <circle cx="0" cy="0" r="18" class="d-line" fill="none"/>
        </g>
        <text x="${x}" y="${y + 34}" class="d-lbl" text-anchor="middle">${String(label).split(" ")[0]}</text>
        <text x="${x}" y="${y + 46}" class="d-lbl" text-anchor="middle">${String(label).split(" ")[1] || ""}</text>`;
      }).join("")}
    </svg>`,
    caption: "Waxing means growing and the lit side is on the right in the northern hemisphere. Waning means shrinking. Quarter phases look like half a disc.",
  },

  punnett: {
    title: "A monohybrid Punnett square",
    svg: `<svg viewBox="0 0 400 175" role="img" aria-label="Punnett square for Bb crossed with Bb giving one BB, two Bb and one bb">
      <text x="120" y="22" class="d-lbl d-key" text-anchor="middle">Bb  &#215;  Bb</text>
      <text x="90" y="46" class="d-lbl" text-anchor="middle">B</text>
      <text x="150" y="46" class="d-lbl" text-anchor="middle">b</text>
      <text x="48" y="80" class="d-lbl">B</text>
      <text x="48" y="132" class="d-lbl">b</text>
      <rect x="62" y="54" width="58" height="44" class="d-fill-1"/>
      <rect x="120" y="54" width="58" height="44" class="d-fill-2"/>
      <rect x="62" y="98" width="58" height="44" class="d-fill-2"/>
      <rect x="120" y="98" width="58" height="44" class="d-fill-3"/>
      <text x="91" y="82" class="d-lbl d-key" text-anchor="middle">BB</text>
      <text x="149" y="82" class="d-lbl d-key" text-anchor="middle">Bb</text>
      <text x="91" y="126" class="d-lbl d-key" text-anchor="middle">Bb</text>
      <text x="149" y="126" class="d-lbl d-key" text-anchor="middle">bb</text>
      <text x="210" y="70" class="d-lbl d-key">Genotype  1 : 2 : 1</text>
      <text x="210" y="86" class="d-lbl">BB : Bb : bb</text>
      <text x="210" y="112" class="d-lbl d-key">Phenotype  3 : 1</text>
      <text x="210" y="128" class="d-lbl">dominant : recessive</text>
    </svg>`,
    caption: "Genotype ratio 1:2:1, phenotype ratio 3:1. Mixing those two up is one of the most common genetics errors.",
  },

  phasechange: {
    title: "Heating curve of water",
    svg: `<svg viewBox="0 0 400 190" role="img" aria-label="Heating curve showing flat plateaus at melting and boiling">
      <line x1="46" y1="160" x2="384" y2="160" class="d-axis"/>
      <line x1="46" y1="20" x2="46" y2="160" class="d-axis"/>
      <text x="200" y="182" class="d-lbl" text-anchor="middle">heat added &#8594;</text>
      <text x="14" y="94" class="d-lbl">temp</text>
      <path d="M52 148 L96 116 L176 116 L214 74 L308 74 L354 34" class="d-line" fill="none"/>
      <text x="66" y="140" class="d-lbl">solid</text>
      <text x="120" y="108" class="d-lbl d-key">melting</text>
      <text x="190" y="100" class="d-lbl">liquid</text>
      <text x="248" y="66" class="d-lbl d-key">boiling</text>
      <text x="340" y="52" class="d-lbl">gas</text>
      <line x1="96" y1="116" x2="176" y2="116" class="d-hi"/>
      <line x1="214" y1="74" x2="308" y2="74" class="d-hi"/>
    </svg>`,
    caption: "Temperature stays flat during a phase change. The energy is breaking attractions between particles, not speeding them up.",
  },

  atmosphere: {
    title: "Layers of the atmosphere",
    svg: `<svg viewBox="0 0 400 190" role="img" aria-label="Troposphere, stratosphere, mesosphere and thermosphere from the ground up">
      ${[
        ["Thermosphere", "auroras, space station", 20, "d-fill-1"],
        ["Mesosphere", "meteors burn up here", 56, "d-fill-2"],
        ["Stratosphere", "ozone layer, jets cruise here", 92, "d-fill-3"],
        ["Troposphere", "all weather, we live here", 128, "d-fill-4"],
      ].map(([n, d, y, f]) =>
        `<rect x="20" y="${y}" width="200" height="32" rx="3" class="${f}"/>
         <text x="30" y="${Number(y) + 14}" class="d-lbl d-key">${n}</text>
         <text x="30" y="${Number(y) + 27}" class="d-lbl">${d}</text>`).join("")}
      <rect x="20" y="160" width="200" height="10" class="d-ground"/>
      <text x="236" y="34" class="d-lbl">temperature rises</text>
      <text x="236" y="70" class="d-lbl">temperature falls</text>
      <text x="236" y="106" class="d-lbl">temperature rises</text>
      <text x="236" y="142" class="d-lbl">temperature falls</text>
      <text x="236" y="170" class="d-lbl d-key">ground</text>
    </svg>`,
    caption: "Bottom to top: troposphere, stratosphere, mesosphere, thermosphere. Temperature alternates falling and rising through them.",
  },

  rockcycle: {
    title: "The rock cycle",
    svg: `<svg viewBox="0 0 400 200" role="img" aria-label="Igneous, sedimentary and metamorphic rock cycle">
      <rect x="150" y="14" width="104" height="38" rx="6" class="d-fill-1"/>
      <text x="202" y="32" class="d-lbl d-key" text-anchor="middle">Igneous</text>
      <text x="202" y="45" class="d-lbl" text-anchor="middle">cooled magma or lava</text>
      <rect x="18" y="128" width="112" height="38" rx="6" class="d-fill-2"/>
      <text x="74" y="146" class="d-lbl d-key" text-anchor="middle">Sedimentary</text>
      <text x="74" y="159" class="d-lbl" text-anchor="middle">compacted sediment</text>
      <rect x="272" y="128" width="112" height="38" rx="6" class="d-fill-3"/>
      <text x="328" y="146" class="d-lbl d-key" text-anchor="middle">Metamorphic</text>
      <text x="328" y="159" class="d-lbl" text-anchor="middle">heat and pressure</text>
      <path d="M156 56 L96 124" class="d-arrow"/><path d="M96 124 l3 -9 l6 6 z" class="d-arrowhead"/>
      <path d="M132 152 L268 152" class="d-arrow"/><path d="M268 152 l-9 -4 l0 8 z" class="d-arrowhead"/>
      <path d="M310 124 L248 56" class="d-arrow"/><path d="M248 56 l9 3 l-5 6 z" class="d-arrowhead"/>
      <text x="96" y="98" class="d-lbl" text-anchor="middle">weathering</text>
      <text x="96" y="110" class="d-lbl" text-anchor="middle">and erosion</text>
      <text x="200" y="146" class="d-lbl" text-anchor="middle">heat and pressure</text>
      <text x="306" y="98" class="d-lbl" text-anchor="middle">melting,</text>
      <text x="306" y="110" class="d-lbl" text-anchor="middle">then cooling</text>
    </svg>`,
    caption: "Any rock can become any other. Melting and cooling makes igneous, heat and pressure makes metamorphic, compaction makes sedimentary.",
  },

  cell: {
    title: "Plant and animal cells",
    svg: `<svg viewBox="0 0 400 185" role="img" aria-label="An animal cell and a plant cell compared">
      <ellipse cx="98" cy="80" rx="76" ry="56" class="d-fill-4"/>
      <circle cx="98" cy="76" r="20" class="d-fill-1"/>
      <text x="98" y="80" class="d-lbl d-key" text-anchor="middle">nucleus</text>
      <ellipse cx="56" cy="106" rx="16" ry="8" class="d-fill-3"/>
      <ellipse cx="140" cy="52" rx="16" ry="8" class="d-fill-3"/>
      <text x="98" y="154" class="d-lbl d-key" text-anchor="middle">Animal cell</text>
      <text x="98" y="168" class="d-lbl" text-anchor="middle">round, no wall, no chloroplasts</text>

      <rect x="226" y="24" width="152" height="112" rx="4" class="d-fill-4"/>
      <rect x="234" y="32" width="136" height="96" rx="3" class="d-fill-2"/>
      <circle cx="286" cy="76" r="19" class="d-fill-1"/>
      <text x="286" y="80" class="d-lbl d-key" text-anchor="middle">nucleus</text>
      <rect x="322" y="52" width="38" height="26" rx="4" class="d-fill-3"/>
      <text x="341" y="68" class="d-lbl" text-anchor="middle">vacuole</text>
      <ellipse cx="250" cy="110" rx="14" ry="7" class="d-chloro"/>
      <ellipse cx="330" cy="106" rx="14" ry="7" class="d-chloro"/>
      <text x="302" y="154" class="d-lbl d-key" text-anchor="middle">Plant cell</text>
      <text x="302" y="168" class="d-lbl" text-anchor="middle">wall, large vacuole, chloroplasts</text>
    </svg>`,
    caption: "Plant cells add a cell wall, a large central vacuole and chloroplasts. Both have a nucleus, membrane, cytoplasm and mitochondria.",
  },
};
