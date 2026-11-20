# SmartTools Dock v0.4: soporte universal de teléfono para taladro atornillador

[English](README.md) · **Español**

Soporte regulable para montar un teléfono (cámara hacia la mecha, pantalla hacia el usuario) sobre un taladro
atornillador inalámbrico. Diseñado para Ingco CDLI20022 + Xiaomi Redmi Note 13, pero **regulable** para otros
modelos.

| Regulación | Rango |
|---|---|
| Largo del teléfono (apaisado) | 140–175 mm (mordaza deslizante + tuerca mariposa M4) |
| Espesor del teléfono | hasta 12 mm, con funda fina |
| Cuerpo del taladro | Ø 38–68 mm aprox. (abrazadera partida: dos V de 90° enfrentadas, goma y 2 tornillos M5 con mariposa) |
| Inclinación de la cámara | 0–25° hacia abajo (bisagra M5 con ranura en arco). **Ponela en unos 15°**: la punta queda 15° por debajo del centro de la imagen (con 0° queda afuera) |

El teléfono va **apaisado, pantalla hacia vos, con el extremo de la cámara contra el tope fijo y la cámara en el borde
inferior**. En un teléfono con el módulo de cámara arriba a la izquierda en la parte trasera, eso significa girarlo
para que la cámara quede abajo. El labio del lado de la cámara es bajo (8 mm), así que nunca tapa la lente.

**Qué cambió.** Cada versión se verificó en el simulador de escena, y cada una corrigió lo que fallaba en la anterior:

- **v0.2** dejaba la cámara entre 12 y 17 cm por encima de la mecha y entre 5 y 8 cm al costado. La punta quedaba
  fuera de la imagen y en la marca A1 no se veía ningún marcador.
- **v0.3** puso la lente justo sobre la mecha, pero baja. Al intersecar la vista de la cámara con las piezas apareció
  la pata del brazo 1,3 mm delante de la lente y la silla tapando la punta: entre el 10 y el 18 % de la vista cercana
  quedaba bloqueada.
- **v0.4:**
  - el brazo es una L: una viga baja a la altura de la bisagra, detrás de las orejas, y un poste al costado del
    teléfono (detrás de la lente, nunca delante);
  - el teléfono va alto, con la lente por encima de la bisagra;
  - la cámara se inclina 15° hacia la punta;
  - `dock.py` interseca la pirámide de visión de la cámara, y un cono de 5° alrededor de la línea hacia la punta, con
    el dock, el cuerpo del taladro y el mandril. Con la inclinación por defecto las dos quedan libres (0 %); la v0.3
    falla la misma prueba.

El software lee esta geometría de `dock.py` (`rig.json`, `lib/dockgeom.ts`), así que el simulador, la vista 3D y las
pruebas de punta a punta usan el dock tal como está diseñado: 40/40 con el teléfono de referencia y con el perfil del
Redmi 15.

## Piezas a imprimir (1 de cada una)

| Archivo | Tamaño aprox. | Volumen sólido | Orientación sugerida |
|---|---|---|---|
| `saddle.stl` (base en V superior) | 60 × 94 × 70 mm | 123 cm³ | Apoyada sobre la cara inferior (abertura de la V hacia la cama). La V a 45° no necesita soportes; los túneles de las correas sí (soportes solo en la cama) |
| `lower.stl` (mordaza en V inferior) | 24 × 94 × 34 mm | 20 cm³ | Con la abertura de la V hacia arriba, las orejas apoyadas: sin soportes |
| `arm.stl` (brazo en L + riel + tope fijo) | 72 × 216 × 83 mm | 67 cm³ | Con la base del riel sobre la cama. Soportes para la viga, la lengüeta y el poste |
| `jaw.stl` (mordaza deslizante) | 19 × 21 × 40 mm | 3 cm³ | Con la cara de apoyo del teléfono hacia la cama |

**Material:** PETG (o ASA/ABS). No uses PLA: se deforma con el calor del motor y del sol.
**Parámetros:** capa de 0.2 mm · 4 perímetros · 5 capas arriba y abajo · relleno gyroid del 30–40 %.
**Tolerancias:** juego de 0.3 mm por lado en la bisagra y en la mordaza. Agujeros para M5 de Ø5.5 y para M4 de Ø4.5.

## Tornillería (no impresa)

- 2 × tornillo M5 × 35 mm + 2 arandelas + 2 tuercas mariposa M5 (bisagra y traba de inclinación)
- 2 × tornillo M5 × 80 mm + 2 arandelas planas + 2 **arandelas de presión** + 2 tuercas mariposa M5 (abrazadera). Para cuerpos de hasta Ø56 mm alcanza con M5 × 60
- 1 × tornillo M4 × 16 mm + arandela + tuerca mariposa M4 (mordaza)
- Opcional: 1 correa de velcro de 20 mm × 300 mm como respaldo (pasa por los túneles de la base)
- Goma o neoprene autoadhesivo de 2 mm para pegar en las **4** caras de las dos V (agarre y amortiguación de vibraciones)
- Opcional: tira de goma espuma de 2 mm en el fondo del riel, para teléfonos finos

## Armado

1. Pegá la goma en las 4 caras de las dos V.
2. Apoyá la base sobre el cuerpo del motor, detrás del mandril y delante del gatillo. Poné la mordaza inferior debajo, pasá los 2 tornillos M5 × 80 de arriba hacia abajo por las orejas y apretá las mariposas (con arandela de presión) en forma pareja, de a poco de cada lado, hasta que no gire ni deslice. No aprietes de más: la carcasa es de plástico.
   Opcional: pasá una correa de velcro por un túnel como respaldo.
3. Meté la lengüeta del brazo entre las orejas: el M5 de adelante es la bisagra y el de atrás va por la ranura en arco
   (traba). El riel queda detrás de la silla, por encima de la bisagra, y se extiende hacia un costado; el poste del
   brazo queda al costado del teléfono.
4. Apoyá el teléfono apaisado en el riel, con la pantalla hacia vos, **el extremo de la cámara contra el tope fijo y la
   cámara en el borde inferior**. Acercá la mordaza y apretá la mariposa M4.
5. Poné la inclinación en unos 15° (la punta en la mitad inferior de la imagen) y apretá la mariposa de la traba. No
   hace falta que sea exacto: la app mide el ángulo real al calibrar.
6. En la app: imprimí `/markers` y abrí `/hud` → **Cam**. Una vez por teléfono, tocá **Lens** y mové el teléfono sobre la
   hoja durante 20 s. Después apoyá la punta en **A2**, tocá **Calibrate**, describí círculos con el taladro alrededor de
   la punta durante 5 s y giralo sobre la mecha durante otros 5 s.

## Antes de mandar a imprimir: medí tu taladro

No tengo los planos del Ingco CDLI20022, así que la abrazadera usa dos V que se adaptan a varios diámetros
(el script lo verifica de Ø38 a Ø68 mm sin choques entre piezas). Con un calibre, verificá:

- [ ] Que el diámetro del cuerpo del motor, entre el mandril y el gatillo, esté entre 38 y 68 mm.
- [ ] Que haya al menos 60 mm de largo libre arriba para la base y 24 mm abajo para la mordaza inferior, delante del gatillo (sin el selector de torque ni la luz LED).
- [ ] Que el selector de avance/retroceso y el de velocidad queden accesibles con la base puesta.

- [ ] Que nada del taladro sobresalga hacia arriba delante de la lente entre la silla y el mandril (una luz o un
      selector altos). `dock.py` verifica la silla, la bisagra, el cuerpo y el mandril, no los detalles de tu taladro.

Medí también tu teléfono y tu taladro, cargalos en `dock.py` y regenerá:

| Parámetro | Qué es | Referencia |
|---|---|---|
| `PHONE_REF_LEN`, `PHONE_REF_H`, `PHONE_REF_T` | Largo, alto y espesor del teléfono | Redmi Note 13: 162,2 × 75,4 × 8,0 mm |
| `CAM_FROM_END`, `CAM_FROM_EDGE` | Centro de la lente principal desde el extremo corto y desde el borde largo | 15 y 14 mm (aproximado) |
| `BODY_D_REF` | Diámetro del cuerpo del motor donde va la silla | 56 mm |
| `TIP_X_REF` | Del centro de la silla a la punta de la mecha, a lo largo de la mecha, con la mecha que vas a usar | 190 mm |

El software lee estos valores de `rig.json` / `lib/dockgeom.ts`, que se generan al regenerar. Después de cambiarlos,
corré `npm run test:e2e -- --only rig`: verifica que la punta quede dentro de la imagen y que se vean al menos 6
marcadores en cada marca.

## Regenerar los STL

```bash
python3 -m venv .venv && .venv/bin/pip install manifold3d numpy matplotlib
.venv/bin/python dock.py
```

El script también:

- verifica que las piezas no choquen entre sí ni con el cuerpo del taladro (inclinación de 0°, 15° y 25°, de Ø40 a
  Ø68 mm);
- verifica la vista de la cámara: ni su pirámide ni el cono hacia la punta pueden tocar el dock, el cuerpo ni el mandril;
- calcula el largo de tornillo necesario;
- genera `preview.png`, `rig.json` y `../../lib/dockgeom.ts` (la geometría para el software).

## Limitaciones conocidas (v0.4)

- **Todavía no se probó físicamente.** Imprimí uno y probalo antes de hacer más.
- **El teléfono queda en voladizo hacia un costado y alto**, para que la cámara vea por encima de la bisagra, justo
  sobre la mecha. Un refuerzo rigidiza el poste, pero revisá la vibración en la primera impresión. Si vibra, agregá un
  segundo apoyo o acortá `PHONE_LEN_MAX`.
- La posición de la cámara dentro del teléfono (`CAM_FROM_END`, `CAM_FROM_EDGE`) es aproximada: medila.
- La cámara no tiene que quedar paralela a la mecha: **Calibrate** mide la posición de la punta (círculos alrededor de la
  punta) y el eje (giro sobre la mecha). En el simulador de escena los dos salen con menos de 0,1 mm y 0,01° de error.
- Las vibraciones pueden aflojar las mariposas: usá arandelas de presión y revisá el ajuste antes de cada sesión. En la
  app, apoyá la punta en A2 para verificar la calibración: si el dock se movió, recalibrá.

## Licencia

Apache License 2.0, como el resto del repositorio. Ver [LICENSE](../../LICENSE).
