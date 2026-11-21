# Prueba de campo: el teléfono en un taladro real

Guía para la primera prueba física de SmartTools: un atornillador/taladro INGCO 20V, un soporte provisorio y el
Redmi 15. Mide tres cosas y deja un registro de cada una:

1. **Exactitud en un punto.** La punta apoyada en el objetivo impreso A2: ¿a cuántos milímetros la ubica la app?
2. **Estabilidad con el motor apagado y encendido.** Con el taladro quieto, ¿cuánto tiembla la dirección medida
   de la mecha? Se mide sin filtro (cada cuadro tal cual) y con el filtro (la pose con la que decide el freno).
3. **Un trabajo completo de 4 agujeros.** Lo que registró la app frente a lo que mide un calibre.

La app graba todo y lo exporta como archivos. Las corridas se publican en
[/benchmarks](https://smarttools-nav.vercel.app/benchmarks) junto a la corrida **simulada** de referencia, para
comparar.

> **Precisión no es exactitud.** La prueba 2 mide cuánto tiembla la medición (precisión); no dice si la mecha
> apunta a donde la app cree. Para eso están la prueba 1 (un punto conocido) y la 3 (el calibre). En los
> resultados, cada cosa se nombra por lo que es.

Tiempo estimado: 2 horas, incluido el montaje.

---

## 0. Antes de empezar

### Materiales

- [ ] El atornillador INGCO 20V con la batería cargada, y una **mecha para madera de 6 mm**.
- [ ] El **Redmi 15**, cargado, con la funda que vas a usar.
- [ ] **La hoja de marcadores** (https://smarttools-nav.vercel.app/markers) impresa en A4 al **100 %**. Medí la
      línea de 50 mm del margen: si no mide 50 mm, imprimila de nuevo.
- [ ] **Una tabla de madera de al menos 30 mm de espesor** (pino sirve), de unos 30 × 40 cm, y cinta de
      papel para pegar la hoja bien plana.
- [ ] **Para el soporte provisorio:** 2 o 3 abrazaderas metálicas o bridas plásticas gruesas, un taco de
      madera, goma o cinta doble faz, y cinta americana.
- [ ] **Para fijar el taladro en la prueba 2:** una morsa, o 2 sargentos que lo sujeten de la empuñadura al
      borde de una mesa.
- [ ] **Para medir:** un calibre con varilla de profundidad, una escuadra o un taco escuadrado, y una regla.
- [ ] **Un segundo teléfono** para filmar (para el video).
- [ ] **Seguridad:** anteojos de protección, y la tabla bien sujeta antes de perforar.

### En el teléfono

1. Abrí https://smarttools-nav.vercel.app/hud en Chrome y agregala a la pantalla de inicio (⋮ → *Instalar
   app*). Abrila desde el ícono: queda a pantalla completa y funciona sin conexión.
2. Tocá **View** hasta que diga **Cam** y aceptá el permiso de cámara.
3. Tocá **Phone** hasta que diga **Redmi 15**.
4. Brillo de pantalla alto. Activá **No molestar**, para que ninguna notificación interrumpa una grabación.

### La hoja

Pegá la hoja plana sobre la tabla, sin arrugas ni burbujas, con cinta en los cuatro bordes. La luz tiene que
ser pareja: sin reflejos sobre la hoja y sin la sombra del taladro tapando muchos marcadores.

---

## 1. Calibrar el lente (antes de montar el teléfono)

Se hace una sola vez por teléfono, con el teléfono en la mano.

1. En **Cam**, tocá **Lens**.
2. Durante 20 s mové el teléfono sobre la hoja: de cerca y de lejos, inclinándolo hacia los cuatro lados.
   Siempre con muchos marcadores a la vista.
3. Al terminar, la app muestra `LENS OK · N VIEWS · X PX`. **Anotá X.** Por debajo de 1 px está muy bien.
   Si da error o X pasa de 2 px, repetilo con mejor luz.

---

## 2. El soporte provisorio

El soporte impreso todavía no está. Este montaje provisorio sirve para medir hoy, si cumple tres cosas:

1. **Rígido.** El teléfono no se puede mover respecto del taladro: ni al tocar la pantalla ni con el motor en
   marcha. Si se mueve, toda medida es del soporte y no del sistema. Probalo empujando el teléfono con un dedo:
   no tiene que ceder.
2. **La punta de la mecha a la vista**, en la mitad de abajo de la imagen. El teléfono va **apaisado**, con la
   pantalla hacia vos y la cámara mirando hacia adelante y hacia abajo, a lo largo de la mecha, con unos
   15° de inclinación.
3. **Los marcadores a la vista.** El soporte no debe tapar la cámara.

Una forma que funciona:
- **El taco:** un taco de madera atado al cuerpo del taladro, detrás del anillo de torque, con 2 abrazaderas o
  bridas gruesas bien apretadas.
- **El teléfono:** pegado al taco con cinta doble faz más cinta americana, con goma entre teléfono y taco.
- **Antes de seguir:** mirá la pantalla. La punta de la mecha tiene que aparecer abajo en la imagen, y la
  hoja con muchos marcadores alrededor.

> En el laboratorio de la app, el botón del montaje tiene que decir **provisional mount**. Queda guardado en
> cada corrida, porque un montaje provisorio vibra distinto que el soporte impreso.

---

## 3. Calibrar la punta y el eje de la mecha

Cada vez que montes o muevas el teléfono:

1. Apoyá la punta de la mecha en el **centro de A2**.
2. Tocá **Calibrate**:
   - **primeros 5 s:** girá el taladro en círculos alrededor de la punta, sin despegarla de A2, inclinándolo
     unos 10–15° hacia todos lados;
   - **siguientes 5 s:** con la punta en el mismo lugar, girá el taladro sobre su propia mecha, de un lado al
     otro.
3. Mensajes esperados:
   - `TIP OK · X MM` al terminar el primer paso. **Anotá X.** Menos de 0,5 mm está muy bien.
   - `DOCK CALIBRATED · TILT ≈ N°` al final. Con el soporte provisorio también puede salir
     `CHECK THE PHONE: TIP … MM FROM THE REDMI 15 PROFILE`. **Es esperable:** el perfil describe el
     soporte impreso, no tu montaje, y la calibración mide el real igual.
4. Si algo falla, repetilo con más marcadores a la vista y movimientos más lentos.

---

## 4. Prueba 1: exactitud en A2

Abrí el laboratorio con el botón **Bench**. El panel muestra en vivo:
- cuántos marcadores ve;
- el ángulo de la mecha respecto de la hoja;
- la distancia de la punta a A2;
- el temblor del último segundo, crudo y filtrado;
- el acelerómetro.

1. Motor apagado. Apoyá la punta en el centro de A2, con el taladro lo más escuadrado posible (podés
   apoyarlo contra la escuadra).
2. Tocá **Check on A2 5s**. Hay una cuenta regresiva de 3 s y después graba 5 s: quedate quieto.
3. En la tabla del panel aparece `A2 x.xx`: es la distancia media de la punta a A2, en mm.
4. **Repetilo 3 veces**, levantando el taladro y volviendo a apoyarlo cada vez. Cada toma reemplaza a la
   anterior en el panel, así que **anotá el valor de cada una** en la tabla de resultados.

Para mirar: el objetivo de diseño es **menos de 1 mm**. La columna `bit vs sheet` te dice qué tan escuadrado
lo tenías.

---

## 5. Prueba 2: motor apagado y motor encendido (estabilidad)

Para que mida la vibración del motor y no el pulso de tu mano, **el taladro tiene que estar fijo**.

1. **Fijalo:** sujetalo con la morsa o con dos sargentos de la empuñadura al borde de la mesa, con la mecha
   vertical apuntando a A2 y la **punta a 3–5 mm de la hoja, sin tocarla**. La tabla con la hoja va debajo,
   también fija.
2. En el panel Bench, revisá que diga muchos marcadores (más de 8) y que el temblor del último segundo sea
   chico.
3. **Motor off 10s:** tocalo y no toques nada durante la cuenta y los 10 s.
4. **Motor on (free spin) 10s:** tocalo y, durante la cuenta regresiva, apretá el gatillo **a fondo**, en la
   **velocidad 2** (alta) del selector. Mantenelo hasta que termine. La mecha gira en el aire.
5. Repetí el paso 4 en **velocidad 1** si querés comparar, guardando una corrida por velocidad (ver más abajo).
6. Mirá la tabla del panel: `angle σ raw/filt`. Lo esperable es que con el motor encendido el valor crudo
   suba y el filtrado suba menos.
7. **El interruptor `filter on/off` cambia solo lo que se ve en pantalla.** Las dos señales, cruda y
   filtrada, se graban siempre. Usalo en el video para mostrar la diferencia a simple vista.
8. Tocá **save run**. La corrida queda guardada en el teléfono (en `/memory` y en `/benchmarks`) y además se
   descarga un archivo `smarttools-bench-….json`.

Si querés, sin el taladro fijo (en la mano), repetí motor apagado y encendido y guardalo como otra corrida. En
las notas que me pases, aclarame que fue a mano: la diferencia con la corrida fija muestra cuánto es pulso.

> Mientras el panel Bench está abierto, la app no extrapola la pose ("prediction off"). Así lo que se mide como
> "filtrado" es exactamente lo que usa el freno para decidir.

---

## 6. Prueba 3: un trabajo de 4 agujeros

1. **El plan:** en la barra de abajo, tocá el nombre del plan hasta que diga
   **Demo: 4 holes, 40 mm square, 20 mm deep**. Son 4 agujeros de Ø6 mm y 20 mm de profundidad, en un cuadrado
   de 40 × 40 mm (D1 a D4), en los huecos entre marcadores. **A2 queda libre**, así podés recalibrar después.
2. Tocá **Sound** para tener el tono de guía.
3. **Opcional:** con el panel Bench abierto, tocá **Drilling 10s** justo antes de empezar D1 y perforá durante
   la grabación. Queda medida la vibración con carga real.
4. **Por cada agujero:**
   - llevá la punta al anillo que indica la pantalla;
   - alineá hasta que el freno se ponga en verde (escuadrado y centrado);
   - perforá hasta que la pantalla indique la profundidad;
   - retirá.
   La app registra el agujero sola.
5. Al terminar los 4, tocá **Finish job**. Aparece `JOB SAVED · …` con el veredicto.
6. **Medí con el calibre** y anotá:
   - la **profundidad** real de cada agujero, con la varilla del calibre;
   - la **separación** entre centros: D1–D2 y D4–D3 (horizontal), D2–D3 y D1–D4 (vertical). Todas deberían dar
     40,0 mm.
   - si el agujero quedó **perpendicular**: meté la mecha (o un tornillo) en el agujero y medí con la escuadra
     cuánto se inclina.

---

## 7. Opcional: planificar con el taladro como puntero

1. Tocá **New plan**. Apoyá la punta en un punto libre de la hoja (entre marcadores) y tocá **Mark hole**.
   Repetilo en un segundo punto y tocá **Save**.
2. Perforá esos dos agujeros como en la prueba 3 y tocá **Finish job**.

---

## 8. Exportar y pasarme los archivos

En el teléfono, abrí https://smarttools-nav.vercel.app/memory:

- **Bench runs → Download run**, de cada corrida;
- **Jobs → Job record (JSON)**, **agentvcs ledger** y **Report (HTML)**, del trabajo de 4 agujeros.

Pasalos a la laptop por WhatsApp, Drive o cable, a una carpeta `~/Downloads/smarttools-field/`. Agregá un
archivo de texto con tus notas: el montaje, si el taladro estaba fijo o en la mano, la velocidad y tus medidas
con el calibre.

Con eso, yo:
1. publico las corridas reales en `/benchmarks`, rotuladas como medidas, junto a la simulada;
2. agrego al build log lo que encontramos, con los números;
3. comparo lo que registró la app con tus medidas de calibre.

---

## 9. El video

Con el segundo teléfono, en horizontal y con buena luz. Tomas en orden:

1. **El montaje** (5 s): el taladro con el teléfono, girándolo para mostrar el soporte.
2. **La calibración** (10 s): el círculo y el giro sobre A2.
3. **Motor apagado y encendido** (20 s): la pantalla del teléfono con el panel Bench, y el interruptor del
   filtro alternando mientras el motor gira.
4. **Un agujero de principio a fin** (15 s): el anillo, el verde, la perforación, la profundidad.
5. **El calibre** midiendo un agujero (5 s).

Sin audio de fondo o con el tono de la app. Yo edito el corte final si me pasás los clips.

---

## 10. Si algo falla

| Síntoma | Qué hacer |
|---|---|
| Pocos marcadores (menos de 6) | Más luz pareja, sin reflejos. Alejá un poco la cámara (más inclinación) o mové la hoja |
| La punta no aparece en la imagen | Más inclinación hacia abajo. La punta tiene que verse en la mitad inferior |
| `TIP OK` con más de 1 mm | Repetir: la punta no se despegó de A2 y el movimiento fue lento y amplio |
| El acelerómetro dice "no data" | Cerrá y volvé a abrir el panel Bench. El navegador necesita un toque para habilitarlo |
| El freno no se pone en verde | Leé el mensaje: "Hold steady", "Line up the rings", "Tip to the mark" o "Show more markers" |
| El teléfono se calienta y la imagen va lenta | Bajá el brillo y cerrá otras apps; dejalo enfriar 5 min |
| Algo se ve raro después de mover el soporte | Recalibrá la punta (sección 3) |

---

## 11. Tabla de resultados

| Medida | Valor |
|---|---|
| Lente: error de calibración (px) | |
| Punta: error de calibración (mm) | |
| A2, toma 1 / 2 / 3 (mm) | |
| Motor off: ángulo σ crudo / filtrado (°) | |
| Motor on (vel. 2): ángulo σ crudo / filtrado (°) | |
| Motor on (vel. 1): ángulo σ crudo / filtrado (°) | |
| Acelerómetro off / on (m/s²) | |
| D1–D4: profundidad registrada por la app (mm) | |
| D1–D4: profundidad medida con calibre (mm) | |
| Separaciones D1–D2, D2–D3, D3–D4, D4–D1 (mm) | |
| Inclinación de los agujeros (°) | |
| Notas (montaje, fijo / a mano, luz) | |
