// Eval fixtures: original content written for this harness (no third-party text).
// eval/generate-fixtures.ts renders each document to a PDF under eval/fixtures/ (committed,
// so a Chromium update can't silently change what pdf.js extracts); retrieval.eval.ts
// reads those PDFs the way the app does. No imports here: the generator runs under plain
// `node --experimental-strip-types`.

export interface Passage {
  id: string
  // Rendered as-is into the PDF. Plain text for labelling is derived by stripping tags.
  html: string
}

export interface FixtureDoc {
  id: string
  lang: 'en' | 'hi' | 'es'
  // One inner array per PDF page.
  pages: Passage[][]
  // Rendered as an image only (no text layer), like a phone scan.
  scanned?: boolean
}

export type QueryKind =
  | 'exact' // the document's own question, verbatim
  | 'near' // the document's question with small wording changes, same numbers
  | 'numbers' // same method, different numbers
  | 'paraphrase' // a real question about the passage in other words
  | 'cross' // asked in a different language than the document
  | 'negative' // shares wording with a worked example but asks for a different method

export interface FixtureQuery {
  id: string
  lang: 'en' | 'hi' | 'es'
  doc: string
  q: string
  // The passage that answers it.
  expect: string
  kind: QueryKind
}

const frac = (n: string, d: string) => `<span class="frac"><span>${n}</span><span>${d}</span></span>`

export const DOCS: FixtureDoc[] = [
  {
    id: 'maths-notes',
    lang: 'en',
    pages: [
      [
        {
          id: 'ci',
          html: `<h2>Worked Example 1 — Compound interest</h2>
<p><b>Question:</b> Find the amount and the compound interest when ₹12,000 is invested at 8% per annum, compounded annually, for 3 years.</p>
<p><b>Solution:</b></p>
<p>Step 1: Write the formula A = P(1 + ${frac('r', '100')})<sup>n</sup>, where P is the principal, r the rate per cent per annum and n the number of years.</p>
<p>Step 2: Substitute P = 12000, r = 8 and n = 3: A = 12000 × (1 + ${frac('8', '100')})<sup>3</sup> = 12000 × (1.08)<sup>3</sup>.</p>
<p>Step 3: Work out the growth factor: (1.08)<sup>3</sup> = 1.08 × 1.08 × 1.08 = 1.259712.</p>
<p>Step 4: Multiply: A = 12000 × 1.259712 = 15116.544, so A ≈ ₹15,116.54.</p>
<p>Step 5: Compound interest = A − P = 15116.54 − 12000 = ₹3,116.54.</p>
<p><b>Answer:</b> The amount is ₹15,116.54 and the compound interest is ₹3,116.54.</p>`,
        },
        {
          id: 'quad',
          html: `<h2>Worked Example 2 — Solving a quadratic equation with the formula</h2>
<p><b>Question:</b> Solve 2x² − 7x + 3 = 0.</p>
<p><b>Solution:</b></p>
<p>Step 1: Compare with ax² + bx + c = 0: a = 2, b = −7, c = 3.</p>
<p>Step 2: Find the discriminant D = b² − 4ac = (−7)² − 4 × 2 × 3 = 49 − 24 = 25.</p>
<p>Step 3: Since D &gt; 0 there are two real roots, and √D = 5.</p>
<p>Step 4: Use x = ${frac('−b ± √D', '2a')} = ${frac('7 ± 5', '4')}.</p>
<p>Step 5: x = ${frac('12', '4')} = 3 or x = ${frac('2', '4')} = ½.</p>
<p><b>Answer:</b> x = 3 or x = ½.</p>`,
        },
      ],
      [
        {
          id: 'si',
          html: `<h2>Worked Example 3 — Simple interest</h2>
<p><b>Question:</b> Find the simple interest on ₹5,000 at 6% per annum for 4 years.</p>
<p><b>Solution:</b></p>
<p>Step 1: Write the formula SI = ${frac('P × R × T', '100')}.</p>
<p>Step 2: Substitute P = 5000, R = 6 and T = 4.</p>
<p>Step 3: SI = ${frac('5000 × 6 × 4', '100')} = ${frac('120000', '100')} = 1200.</p>
<p>Step 4: Amount = P + SI = 5000 + 1200 = 6200.</p>
<p><b>Answer:</b> The simple interest is ₹1,200 and the amount is ₹6,200.</p>`,
        },
        {
          id: 'pct',
          html: `<h2>Worked Example 4 — Percentage increase</h2>
<p><b>Question:</b> A shirt's price rises from ₹800 to ₹920. Find the percentage increase.</p>
<p><b>Solution:</b></p>
<p>Step 1: Increase = new price − old price = 920 − 800 = 120.</p>
<p>Step 2: Percentage increase = ${frac('increase', 'original price')} × 100.</p>
<p>Step 3: ${frac('120', '800')} × 100 = 15.</p>
<p><b>Answer:</b> The price increased by 15%.</p>`,
        },
      ],
      [
        {
          id: 'speed',
          html: `<h2>Worked Example 5 — Average speed</h2>
<p><b>Question:</b> A car travels 150 km at 50 km/h and then 150 km at 75 km/h. Find the average speed for the whole journey.</p>
<p><b>Solution:</b></p>
<p>Step 1: Time for the first part = 150 ÷ 50 = 3 h.</p>
<p>Step 2: Time for the second part = 150 ÷ 75 = 2 h.</p>
<p>Step 3: Total distance = 300 km and total time = 5 h.</p>
<p>Step 4: Average speed = total distance ÷ total time = 300 ÷ 5 = 60 km/h.</p>
<p><b>Note:</b> the average speed is not the mean of 50 and 75, because the car spends longer at the slower speed.</p>`,
        },
        {
          id: 'trap',
          html: `<h2>Worked Example 6 — Area of a trapezium</h2>
<p><b>Question:</b> Find the area of a trapezium whose parallel sides are 10 cm and 6 cm and whose height is 4 cm.</p>
<p><b>Solution:</b></p>
<p>Step 1: Write the formula Area = ½ × (a + b) × h.</p>
<p>Step 2: Substitute a = 10, b = 6 and h = 4.</p>
<p>Step 3: Area = ½ × 16 × 4 = 32.</p>
<p><b>Answer:</b> The area is 32 cm².</p>`,
        },
      ],
    ],
  },
  {
    id: 'finance-report',
    lang: 'en',
    pages: [
      [
        {
          id: 'table',
          html: `<h2>Northwind Stationery — quarterly results, FY2025 (₹ thousand)</h2>
<table>
<tr><th>Quarter</th><th>Revenue</th><th>Cost of goods sold</th><th>Gross profit</th><th>Operating expenses</th><th>Net income</th></tr>
<tr><td>Q1</td><td>420</td><td>252</td><td>168</td><td>96</td><td>72</td></tr>
<tr><td>Q2</td><td>465</td><td>270</td><td>195</td><td>101</td><td>94</td></tr>
<tr><td>Q3</td><td>510</td><td>301</td><td>209</td><td>110</td><td>99</td></tr>
<tr><td>Q4</td><td>600</td><td>342</td><td>258</td><td>125</td><td>133</td></tr>
<tr><td>Total</td><td>1995</td><td>1165</td><td>830</td><td>432</td><td>398</td></tr>
</table>`,
        },
        {
          id: 'margin',
          html: `<h2>Notes on the figures</h2>
<p>Gross margin is gross profit divided by revenue, expressed as a percentage. For Q4 the gross margin was 258 ÷ 600 × 100 = 43%. Net margin is net income divided by revenue; for the full year it was 398 ÷ 1995 × 100 ≈ 19.9%. Cost of goods sold covers paper, ink and packaging bought for resale, but not rent or salaries, which sit in operating expenses.</p>`,
        },
        {
          id: 'outlook',
          html: `<h2>Outlook</h2>
<p>Management expects revenue to grow by about 12% in FY2026, mostly from school-season demand in June and July. A second warehouse in Pune is due to open in March, which should cut delivery times in western India from four days to two.</p>`,
        },
      ],
      [
        {
          id: 'risks',
          html: `<h2>Risks</h2>
<p>Paper prices rose 9% during the year and may rise again, which would squeeze the gross margin. A weaker rupee makes imported ink more expensive. The company also depends on three large school chains for almost a third of its sales.</p>`,
        },
        {
          id: 'dividend',
          html: `<h2>Dividend</h2>
<p>The board recommended a final dividend of ₹4 per share for FY2025, payable on 15 August to shareholders on the register on 1 August. Last year's dividend was ₹3 per share.</p>`,
        },
        {
          id: 'headcount',
          html: `<h2>People</h2>
<p>The company employed 86 people at the end of the year, up from 71 a year earlier. Most new hires work in the warehouse and in customer support.</p>`,
        },
      ],
    ],
  },
  {
    id: 'biology-notes',
    lang: 'en',
    pages: [
      [
        {
          id: 'mito',
          html: `<h2>Mitochondria</h2><p>Mitochondria are the powerhouses of the cell. They produce ATP through cellular respiration, breaking down glucose in the presence of oxygen. Cells that need a lot of energy, such as muscle cells, contain many mitochondria. Mitochondria have their own small circular DNA, which is inherited from the mother.</p>`,
        },
        {
          id: 'osmo',
          html: `<h2>Osmosis</h2><p>Osmosis is the movement of water molecules across a partially permeable membrane, from a region of lower solute concentration to a region of higher solute concentration. A raisin placed in water swells because water enters it by osmosis. Plant cells become turgid when they take in water.</p>`,
        },
        {
          id: 'enz',
          html: `<h2>Enzymes</h2><p>Enzymes are biological catalysts made of protein. Each enzyme has an active site that fits a specific substrate, like a lock and key. Enzymes work best at an optimum temperature; human enzymes work best near 37 °C. High temperatures denature enzymes by changing the shape of the active site.</p>`,
        },
      ],
      [
        {
          id: 'dna',
          html: `<h2>DNA replication</h2><p>DNA replication happens before a cell divides. The double helix unzips as the hydrogen bonds between base pairs break. Each strand acts as a template, and free nucleotides pair with it: adenine with thymine and cytosine with guanine. The result is two identical DNA molecules, each with one old and one new strand.</p>`,
        },
        {
          id: 'nerve',
          html: `<h2>Reflexes</h2><p>The nervous system carries messages as electrical impulses along neurons. A reflex arc is a fast, automatic response: a receptor detects a stimulus, a sensory neuron carries the impulse to the spinal cord, a relay neuron passes it on, and a motor neuron carries it to an effector such as a muscle.</p>`,
        },
        {
          id: 'photo-en',
          html: `<h2>Photosynthesis</h2><p>Photosynthesis takes place in chloroplasts. Plants use light energy absorbed by chlorophyll to convert carbon dioxide and water into glucose and oxygen. The rate of photosynthesis is limited by light intensity, carbon dioxide concentration and temperature.</p>`,
        },
      ],
    ],
  },
  {
    id: 'hindi-notes',
    lang: 'hi',
    pages: [
      [
        {
          id: 'hi-water',
          html: `<h2>जल चक्र</h2><p>सूर्य की गर्मी से समुद्र, नदियों और झीलों का पानी भाप बनकर ऊपर उठता है। इसे वाष्पीकरण कहते हैं। ऊँचाई पर ठंडी हवा में यह भाप छोटी-छोटी बूँदों में बदल जाती है और बादल बनते हैं; इस प्रक्रिया को संघनन कहते हैं। जब बूँदें भारी हो जाती हैं तो वर्षा, ओले या हिम के रूप में धरती पर गिरती हैं। यह पानी फिर से नदियों और भूमिगत जल में पहुँचता है और चक्र चलता रहता है।</p>`,
        },
        {
          id: 'hi-photo',
          html: `<h2>प्रकाश संश्लेषण</h2><p>हरे पौधे अपनी पत्तियों में मौजूद क्लोरोफिल की मदद से सूर्य के प्रकाश को ऊर्जा के रूप में उपयोग करते हैं। वे हवा से कार्बन डाइऑक्साइड और जड़ों से पानी लेकर ग्लूकोज़ बनाते हैं और ऑक्सीजन छोड़ते हैं। यही ऑक्सीजन हम साँस में लेते हैं। प्रकाश संश्लेषण के बिना पृथ्वी पर भोजन श्रृंखला संभव नहीं है।</p>`,
        },
        {
          id: 'hi-const',
          html: `<h2>भारत का संविधान</h2><p>भारत का संविधान 26 नवंबर 1949 को संविधान सभा द्वारा अपनाया गया और 26 जनवरी 1950 को लागू हुआ। इसी दिन को हम गणतंत्र दिवस के रूप में मनाते हैं। संविधान की प्रारूप समिति के अध्यक्ष डॉ. भीमराव आंबेडकर थे। संविधान नागरिकों को मौलिक अधिकार देता है, जैसे समानता का अधिकार और अभिव्यक्ति की स्वतंत्रता।</p>`,
        },
        {
          id: 'hi-gravity',
          html: `<h2>गुरुत्वाकर्षण</h2><p>हर वस्तु दूसरी वस्तु को अपनी ओर खींचती है; इस बल को गुरुत्वाकर्षण कहते हैं। पृथ्वी का गुरुत्वाकर्षण ही पेड़ से गिरे सेब को नीचे लाता है और चंद्रमा को पृथ्वी की कक्षा में बनाए रखता है। पृथ्वी की सतह पर गुरुत्वीय त्वरण लगभग 9.8 मीटर प्रति सेकंड² है। चंद्रमा पर यह पृथ्वी का लगभग छठा भाग है, इसलिए वहाँ वस्तुएँ हल्की महसूस होती हैं।</p>`,
        },
      ],
      [
        {
          id: 'hi-si',
          html: `<h2>हल किया गया उदाहरण — साधारण ब्याज</h2>
<p><b>प्रश्न:</b> ₹8,000 पर 5% वार्षिक दर से 3 वर्ष का साधारण ब्याज ज्ञात कीजिए।</p>
<p><b>हल:</b></p>
<p>चरण 1: सूत्र लिखिए — साधारण ब्याज = (मूलधन × दर × समय) ÷ 100।</p>
<p>चरण 2: मान रखिए — मूलधन = 8000, दर = 5, समय = 3।</p>
<p>चरण 3: साधारण ब्याज = (8000 × 5 × 3) ÷ 100 = 120000 ÷ 100 = 1200।</p>
<p>चरण 4: मिश्रधन = मूलधन + ब्याज = 8000 + 1200 = 9200।</p>
<p><b>उत्तर:</b> साधारण ब्याज ₹1,200 और मिश्रधन ₹9,200 है।</p>`,
        },
        {
          id: 'hi-monsoon',
          html: `<h2>मानसून</h2><p>भारत में अधिकांश वर्षा दक्षिण-पश्चिम मानसून से जून से सितंबर के बीच होती है। गर्मियों में स्थल भाग समुद्र की तुलना में अधिक गर्म हो जाता है, जिससे हिंद महासागर से नमी भरी हवाएँ देश की ओर बहती हैं। केरल में मानसून सामान्यतः 1 जून के आसपास पहुँचता है। खेती, विशेषकर धान की फसल, मानसून पर बहुत निर्भर है।</p>`,
        },
        {
          id: 'hi-digest',
          html: `<h2>पाचन तंत्र</h2><p>भोजन का पाचन मुँह से शुरू होता है, जहाँ लार में मौजूद एंजाइम स्टार्च को तोड़ना शुरू करता है। आमाशय में अम्ल और पेप्सिन प्रोटीन को पचाते हैं। छोटी आंत में अधिकांश पाचन और पोषक तत्वों का अवशोषण होता है। बड़ी आंत पानी को सोख लेती है और बचा हुआ अपशिष्ट शरीर से बाहर निकल जाता है।</p>`,
        },
        {
          id: 'hi-soil',
          html: `<h2>मिट्टी के प्रकार</h2><p>भारत में मुख्य रूप से जलोढ़, काली, लाल और लैटेराइट मिट्टी पाई जाती है। जलोढ़ मिट्टी नदियों द्वारा लाई जाती है और गंगा के मैदान में बहुत उपजाऊ है। काली मिट्टी नमी को देर तक रोके रखती है, इसलिए कपास की खेती के लिए उपयुक्त है। लाल मिट्टी में लोहे की मात्रा अधिक होने से उसका रंग लाल होता है।</p>`,
        },
      ],
    ],
  },
  {
    id: 'spanish-notes',
    lang: 'es',
    pages: [
      [
        {
          id: 'es-agua',
          html: `<h2>El ciclo del agua</h2><p>El calor del sol evapora el agua de mares, ríos y lagos. El vapor sube, se enfría en las capas altas de la atmósfera y se condensa en pequeñas gotas que forman las nubes. Cuando las gotas pesan demasiado, caen como lluvia, nieve o granizo. Parte del agua se infiltra en el suelo y alimenta los acuíferos; otra parte corre por la superficie hasta volver al mar.</p>`,
        },
        {
          id: 'es-foto',
          html: `<h2>La fotosíntesis</h2><p>Las plantas verdes captan la luz solar con la clorofila de sus hojas. Con esa energía combinan el dióxido de carbono del aire y el agua que absorben las raíces para fabricar glucosa, y liberan oxígeno como subproducto. Este proceso ocurre en los cloroplastos y es la base de casi todas las cadenas alimentarias.</p>`,
        },
        {
          id: 'es-rev',
          html: `<h2>La Revolución Francesa</h2><p>Comenzó en 1789, cuando una crisis económica y el descontento con la monarquía absoluta llevaron a la toma de la Bastilla el 14 de julio. La Asamblea Nacional aprobó la Declaración de los Derechos del Hombre y del Ciudadano. En 1792 se proclamó la República y al año siguiente fue ejecutado el rey Luis XVI.</p>`,
        },
        {
          id: 'es-cervantes',
          html: `<h2>Cervantes</h2><p>Miguel de Cervantes publicó la primera parte de Don Quijote de la Mancha en 1605 y la segunda en 1615. Antes de escribir fue soldado y perdió el uso de la mano izquierda en la batalla de Lepanto, por lo que lo llamaron «el manco de Lepanto».</p>`,
        },
      ],
      [
        {
          id: 'es-interes',
          html: `<h2>Ejemplo resuelto — Interés compuesto</h2>
<p><b>Problema:</b> Calcula el monto final si inviertes 2.000 € al 5 % anual con capitalización anual durante 3 años.</p>
<p><b>Solución:</b></p>
<p>Paso 1: Escribe la fórmula M = C · (1 + ${frac('r', '100')})<sup>n</sup>.</p>
<p>Paso 2: Sustituye C = 2000, r = 5 y n = 3: M = 2000 · (1,05)<sup>3</sup>.</p>
<p>Paso 3: Calcula (1,05)<sup>3</sup> = 1,157625.</p>
<p>Paso 4: M = 2000 · 1,157625 = 2315,25 €.</p>
<p>Paso 5: El interés ganado es 2315,25 − 2000 = 315,25 €.</p>`,
        },
        {
          id: 'es-volcan',
          html: `<h2>Los volcanes</h2><p>Un volcán es una abertura en la corteza terrestre por la que sale magma del interior. Cuando el magma llega a la superficie se llama lava. Las erupciones pueden expulsar ceniza, gases y fragmentos de roca. Muchos volcanes se encuentran en el Cinturón de Fuego del Pacífico, donde chocan las placas tectónicas.</p>`,
        },
        {
          id: 'es-corazon',
          html: `<h2>El corazón humano</h2><p>El corazón es un músculo con cuatro cavidades: dos aurículas y dos ventrículos. El lado derecho envía la sangre pobre en oxígeno a los pulmones, y el lado izquierdo bombea la sangre oxigenada a todo el cuerpo a través de la arteria aorta. En reposo late entre 60 y 100 veces por minuto.</p>`,
        },
        {
          id: 'es-dieta',
          html: `<h2>La dieta mediterránea</h2><p>Se basa en frutas, verduras, legumbres, cereales integrales y aceite de oliva como grasa principal. Incluye pescado varias veces por semana y poca carne roja. Diversos estudios la asocian con un menor riesgo de enfermedades cardiovasculares.</p>`,
        },
      ],
    ],
  },
  {
    id: 'scanned-lab',
    lang: 'en',
    scanned: true,
    pages: [
      [
        {
          id: 'scan-pendulum',
          html: `<h2>Lab notes — simple pendulum</h2><p>We timed 20 swings of a 1.0 m pendulum three times: 40.2 s, 40.0 s and 40.4 s. The mean time for 20 swings was 40.2 s, so the period was 2.01 s. Doubling the mass of the bob did not change the period.</p>`,
        },
        {
          id: 'scan-titration',
          html: `<h2>Lab notes — titration</h2><p>25.0 cm³ of sodium hydroxide was titrated with 0.10 mol/dm³ hydrochloric acid using phenolphthalein. The indicator turned colourless after 22.5 cm³ of acid on average, so the alkali's concentration was 0.090 mol/dm³.</p>`,
        },
      ],
    ],
  },
]

export const QUERIES: FixtureQuery[] = [
  // Maths worked examples: the document's own question, small rewordings, new numbers.
  { id: 'm1', lang: 'en', doc: 'maths-notes', kind: 'exact', expect: 'ci', q: 'Find the amount and the compound interest when ₹12,000 is invested at 8% per annum, compounded annually, for 3 years.' },
  { id: 'm2', lang: 'en', doc: 'maths-notes', kind: 'near', expect: 'ci', q: 'find the amount and compound interest if Rs 12000 is invested at 8% per annum compounded annually for 3 years' },
  { id: 'm3', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'ci', q: 'Find the amount and the compound interest when ₹25,000 is invested at 6% per annum, compounded annually, for 4 years.' },
  { id: 'm4', lang: 'en', doc: 'maths-notes', kind: 'paraphrase', expect: 'ci', q: 'How do I calculate interest that is added to the principal every year?' },
  { id: 'm5', lang: 'en', doc: 'maths-notes', kind: 'exact', expect: 'quad', q: 'Solve 2x² − 7x + 3 = 0.' },
  { id: 'm6', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'quad', q: 'Solve 3x² - 10x + 8 = 0' },
  { id: 'm7', lang: 'en', doc: 'maths-notes', kind: 'paraphrase', expect: 'quad', q: 'How do you use the discriminant to find the roots of a quadratic?' },
  { id: 'm8', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'si', q: 'Find the simple interest on ₹9,000 at 5% per annum for 3 years.' },
  { id: 'm9', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'pct', q: "A bag's price rises from ₹1,200 to ₹1,500. Find the percentage increase." },
  { id: 'm10', lang: 'en', doc: 'maths-notes', kind: 'exact', expect: 'speed', q: 'A car travels 150 km at 50 km/h and then 150 km at 75 km/h. Find the average speed for the whole journey.' },
  { id: 'm11', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'speed', q: 'A cyclist rides 60 km at 20 km/h and then 60 km at 30 km/h. Find the average speed for the whole journey.' },
  { id: 'm12', lang: 'en', doc: 'maths-notes', kind: 'numbers', expect: 'trap', q: 'Find the area of a trapezium whose parallel sides are 14 cm and 8 cm and whose height is 5 cm.' },
  { id: 'm13', lang: 'en', doc: 'maths-notes', kind: 'paraphrase', expect: 'trap', q: 'What is the formula for the area of a shape with two parallel sides?' },
  { id: 'm14', lang: 'en', doc: 'maths-notes', kind: 'exact', expect: 'si', q: 'Find the simple interest on ₹5,000 at 6% per annum for 4 years.' },
  // Hard negatives for the verbatim rule: one method's wording with another's numbers.
  { id: 'n1', lang: 'en', doc: 'maths-notes', kind: 'negative', expect: 'ci', q: 'Find the compound interest on ₹5,000 at 6% per annum for 4 years.' },
  { id: 'n2', lang: 'en', doc: 'maths-notes', kind: 'negative', expect: 'si', q: 'Find the simple interest on ₹12,000 at 8% per annum for 3 years.' },
  // Finance table and notes.
  { id: 'f1', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'table', q: 'What was the net income in Q3?' },
  { id: 'f2', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'table', q: 'Which quarter had the highest revenue?' },
  { id: 'f3', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'margin', q: 'How is gross margin calculated?' },
  { id: 'f4', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'dividend', q: 'What dividend did the board recommend?' },
  { id: 'f5', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'outlook', q: 'How fast is revenue expected to grow next year?' },
  { id: 'f6', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'risks', q: 'What could hurt profits?' },
  { id: 'f7', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'headcount', q: 'How many employees did the company have at the end of the year?' },
  // Biology.
  { id: 'b1', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'mito', q: 'What do mitochondria produce?' },
  { id: 'b2', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'osmo', q: 'Why does a raisin swell in water?' },
  { id: 'b3', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'enz', q: 'What happens to enzymes at high temperature?' },
  { id: 'b4', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'dna', q: 'Which bases pair together when DNA is copied?' },
  { id: 'b5', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'nerve', q: 'What are the steps of a reflex arc?' },
  { id: 'b6', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'photo-en', q: 'What limits how fast plants photosynthesise?' },
  // Hindi.
  { id: 'h1', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-water', q: 'बादल कैसे बनते हैं?' },
  { id: 'h2', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-water', q: 'बारिश का पानी वापस नदियों तक कैसे पहुँचता है?' },
  { id: 'h3', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-photo', q: 'पौधे अपना भोजन कैसे बनाते हैं?' },
  { id: 'h4', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-photo', q: 'पौधे कौन सी गैस छोड़ते हैं?' },
  { id: 'h5', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-const', q: 'गणतंत्र दिवस 26 जनवरी को क्यों मनाया जाता है?' },
  { id: 'h6', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-const', q: 'प्रारूप समिति के अध्यक्ष कौन थे?' },
  { id: 'h7', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-gravity', q: 'चंद्रमा पर चीज़ें हल्की क्यों लगती हैं?' },
  { id: 'h8', lang: 'hi', doc: 'hindi-notes', kind: 'numbers', expect: 'hi-si', q: '₹15,000 पर 4% वार्षिक दर से 2 वर्ष का साधारण ब्याज ज्ञात कीजिए।' },
  { id: 'h9', lang: 'hi', doc: 'hindi-notes', kind: 'exact', expect: 'hi-si', q: '₹8,000 पर 5% वार्षिक दर से 3 वर्ष का साधारण ब्याज ज्ञात कीजिए।' },
  { id: 'h10', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-monsoon', q: 'केरल में मानसून कब आता है?' },
  { id: 'h11', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-digest', q: 'प्रोटीन का पाचन कहाँ होता है?' },
  { id: 'h12', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-soil', q: 'कपास के लिए कौन सी मिट्टी अच्छी है?' },
  { id: 'h13', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-soil', q: 'लाल मिट्टी का रंग लाल क्यों होता है?' },
  // Spanish.
  { id: 's1', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-agua', q: '¿Cómo se forman las nubes?' },
  { id: 's2', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-agua', q: '¿Qué pasa con el agua que se infiltra en el suelo?' },
  { id: 's3', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-foto', q: '¿Qué gas liberan las plantas al fabricar su alimento?' },
  { id: 's4', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-foto', q: '¿En qué parte de la célula vegetal ocurre la fotosíntesis?' },
  { id: 's5', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-rev', q: '¿Cuándo fue la toma de la Bastilla?' },
  { id: 's6', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-rev', q: '¿En qué año se proclamó la República en Francia?' },
  { id: 's7', lang: 'es', doc: 'spanish-notes', kind: 'numbers', expect: 'es-interes', q: 'Calcula el monto final si inviertes 5.000 € al 4 % anual con capitalización anual durante 2 años.' },
  { id: 's8', lang: 'es', doc: 'spanish-notes', kind: 'exact', expect: 'es-interes', q: 'Calcula el monto final si inviertes 2.000 € al 5 % anual con capitalización anual durante 3 años.' },
  { id: 's9', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-volcan', q: '¿Dónde hay muchos volcanes y por qué?' },
  { id: 's10', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-volcan', q: '¿Cómo se llama el magma cuando sale a la superficie?' },
  { id: 's11', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-corazon', q: '¿Cuántas veces late el corazón en reposo?' },
  { id: 's12', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-dieta', q: '¿Qué alimentos son la base de la dieta mediterránea?' },
  { id: 's13', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-cervantes', q: '¿Cuándo se publicó la primera parte del Quijote?' },
  // Harder paraphrases with little word overlap, added equally per language (before any
  // candidate was measured) because the first baseline saturated at 100% for Spanish.
  { id: 'p1', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'mito', q: 'Which part of the cell releases energy from food?' },
  { id: 'p2', lang: 'en', doc: 'biology-notes', kind: 'paraphrase', expect: 'osmo', q: 'What makes a plant cell firm after it is watered?' },
  { id: 'p3', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'dividend', q: 'How much will shareholders be paid for each share?' },
  { id: 'p4', lang: 'en', doc: 'finance-report', kind: 'paraphrase', expect: 'risks', q: 'Is the business relying on a few big customers?' },
  { id: 'p5', lang: 'en', doc: 'maths-notes', kind: 'paraphrase', expect: 'speed', q: 'Why is the mean of two speeds not the average speed?' },
  { id: 'p6', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-agua', q: '¿Por qué llueve?' },
  { id: 'p7', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-corazon', q: '¿Qué órgano manda la sangre hacia los pulmones?' },
  { id: 'p8', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-dieta', q: '¿Qué grasa se usa sobre todo en la cocina mediterránea?' },
  { id: 'p9', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-cervantes', q: '¿Qué le pasó a la mano del autor del Quijote?' },
  { id: 'p10', lang: 'es', doc: 'spanish-notes', kind: 'paraphrase', expect: 'es-rev', q: '¿Qué le ocurrió al monarca francés en 1793?' },
  { id: 'p11', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-photo', q: 'हम जो ऑक्सीजन लेते हैं वह कहाँ से आती है?' },
  { id: 'p12', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-monsoon', q: 'धान की खेती किस पर निर्भर करती है?' },
  { id: 'p13', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-digest', q: 'भोजन से पानी कहाँ सोखा जाता है?' },
  { id: 'p14', lang: 'hi', doc: 'hindi-notes', kind: 'paraphrase', expect: 'hi-gravity', q: 'सेब पेड़ से नीचे क्यों गिरता है?' },
  // Cross-lingual: English questions about the Hindi and Spanish notes (reported, not gated).
  { id: 'x1', lang: 'en', doc: 'hindi-notes', kind: 'cross', expect: 'hi-monsoon', q: 'When does the monsoon reach Kerala?' },
  { id: 'x2', lang: 'en', doc: 'hindi-notes', kind: 'cross', expect: 'hi-const', q: 'Who chaired the drafting committee of the Indian constitution?' },
  { id: 'x3', lang: 'en', doc: 'hindi-notes', kind: 'cross', expect: 'hi-soil', q: 'Which soil is good for growing cotton?' },
  { id: 'x4', lang: 'en', doc: 'spanish-notes', kind: 'cross', expect: 'es-rev', q: 'When was the Bastille stormed?' },
  { id: 'x5', lang: 'en', doc: 'spanish-notes', kind: 'cross', expect: 'es-corazon', q: 'How many times a minute does the heart beat at rest?' },
  // The scanned page: the Documents tab gets no text from it (reported, not gated).
  { id: 'sc1', lang: 'en', doc: 'scanned-lab', kind: 'paraphrase', expect: 'scan-pendulum', q: 'What was the period of the pendulum?' },
  { id: 'sc2', lang: 'en', doc: 'scanned-lab', kind: 'paraphrase', expect: 'scan-titration', q: 'What was the concentration of the sodium hydroxide?' },
]
