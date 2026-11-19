# SmartTools Dock v0.1: soporte universal de teléfono para taladro atornillador

Soporte regulable para montar un teléfono (cámara hacia la mecha, pantalla hacia el usuario) sobre un taladro
atornillador inalámbrico. Diseñado para Ingco CDLI20022 + Xiaomi Redmi Note 13, pero **regulable** para otros
modelos.

| Regulación | Rango |
|---|---|
| Largo del teléfono (apaisado) | 140–175 mm (mordaza deslizante + tuerca mariposa M4) |
| Espesor del teléfono | hasta 12 mm, con funda fina |
| Cuerpo del taladro | Ø 40–68 mm aprox. (bloque en V de 90° + goma + 2 correas) |
| Inclinación de la cámara | ±15° (bisagra M5 con ranura en arco), para dejarla paralela a la mecha |

Los topes del lado de la cámara son bajos (12 mm), así que la cámara queda libre en cualquier modelo.

## Piezas a imprimir (1 de cada una)

| Archivo | Tamaño aprox. | Volumen sólido | Orientación sugerida |
|---|---|---|---|
| `saddle.stl` (base en V) | 60 × 70 × 70 mm | 118 cm³ | Apoyada sobre la cara inferior (abertura de la V hacia la cama). La V a 45° no necesita soportes; los túneles de las correas sí (soportes solo en la cama) |
| `arm.stl` (brazo + riel + tope fijo) | 44 × 196 × 86 mm | 46 cm³ | Acostada de lado (la lengüeta plana sobre la cama). Soportes permitidos |
| `jaw.stl` (mordaza deslizante) | 19 × 21 × 40 mm | 3 cm³ | Con la cara de apoyo del teléfono hacia la cama |

**Material:** PETG (o ASA/ABS). No uses PLA: se deforma con el calor del motor y del sol.
**Parámetros:** capa de 0.2 mm · 4 perímetros · 5 capas arriba y abajo · relleno gyroid del 30–40 %.
**Tolerancias:** juego de 0.3 mm por lado en la bisagra y en la mordaza. Agujeros para M5 de Ø5.5 y para M4 de Ø4.5.

## Tornillería (no impresa)

- 2 × tornillo M5 × 35 mm + 2 arandelas + 2 tuercas mariposa M5 (bisagra y traba de inclinación)
- 1 × tornillo M4 × 16 mm + arandela + tuerca mariposa M4 (mordaza)
- 2 × correa de velcro de 20 mm de ancho y unos 300 mm de largo
- Goma o neoprene autoadhesivo de 2–3 mm para pegar en las dos caras de la V
- Opcional: tira de goma espuma de 2 mm en el fondo del riel, para teléfonos finos

## Armado

1. Pegá la goma en las dos caras de la V.
2. Apoyá la base sobre el cuerpo del motor, detrás del mandril y delante del gatillo, y pasá las 2 correas por los túneles alrededor del taladro.
3. Meté la lengüeta del brazo entre las orejas: el M5 de adelante es la bisagra y el de atrás va por la ranura en arco (traba).
4. Apoyá el teléfono apaisado en el riel, con la pantalla hacia vos y la cámara hacia la mecha, contra el tope fijo. Acercá la mordaza y apretá la mariposa M4.
5. Ajustá la inclinación hasta que la cámara quede paralela a la mecha y apretá la mariposa de la traba.
6. En la app: imprimí `/markers`, abrí `/hud` → **Cam**, apoyá la punta en **A2** y tocá **Calibrate**.

## Antes de mandar a imprimir: medí tu taladro

No tengo los planos del Ingco CDLI20022, así que la base usa una V que se adapta a varios diámetros. Con un calibre, verificá:

- [ ] Que el diámetro del cuerpo del motor, entre el mandril y el gatillo, esté entre 40 y 68 mm.
- [ ] Que haya al menos 60 mm de largo libre ahí para apoyar la base (sin el selector de torque ni la luz LED).
- [ ] Que el selector de avance/retroceso y el de velocidad queden accesibles con la base puesta.

Si algo no entra, cambiá los parámetros en `dock.py` (por ejemplo `SAD_X`, `SAD_BOT`, `PHONE_LEN_MAX`) y regenerá.

## Regenerar los STL

```bash
python3 -m venv .venv && .venv/bin/pip install manifold3d numpy matplotlib
.venv/bin/python dock.py
```

El script también verifica que las piezas no se interfieran (con inclinación de 0° y ±15°) y genera `preview.png`.

## Limitaciones conocidas (v0.1)

- **No está probado físicamente.** Es la primera iteración: imprimí una y probala antes de hacer más.
- El software supone que la cámara queda paralela a la mecha. La traba de inclinación permite ajustarlo a ojo; la calibración automática del eje es el próximo paso.
- Las vibraciones del percutor (si lo usás) pueden aflojar las mariposas: usá arandelas de presión.
