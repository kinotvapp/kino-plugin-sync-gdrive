# Kino Sync for Google Drive (experimental)

[Read in English](README.md)

Un **proveedor de sync de Kino** que guarda la copia cifrada en el **Drive de la propia persona**, sin servidor tuyo, sin hojas de cálculo que copiar y sin tokens que pegar: la persona toca **Conectar con Google**, escribe un código en `google.com/device` y listo (el mismo trámite que las apps de TV).

Es un experimento. No es parte de Kino ni está recomendado. **Está probado contra una imitación de Google (a local imitation of Google), no contra Google de verdad.**

```
tu celular ─┐                                           ┌─ Drive de la persona
            ├─ plugin ─ https ─▶ oauth2.googleapis.com  │   (carpeta oculta de la app:
tu TV   ────┘                    www.googleapis.com ────┘    kino-sync.bin, cifrado)
```

## Qué ve la persona
1. **Conectar con Google** → el plugin muestra un código (por ejemplo `ABCD-EFGH`).
2. En otro aparato abre `google.com/device`, escribe el código, elige su cuenta y acepta.
3. Vuelve y toca **Ya lo hice**. Cada aparato se conecta por su cuenta; la copia es la misma para todos.

La clave de cifrado la crea Kino sola (`generateKey`) y viaja entre aparatos con **Enviar / Recibir configuración**; **Google nunca la recibe**, solo ve el archivo cifrado. (En el desktop esa función todavía no existe: ahí la clave tendría que ponerse a mano.)

## Lo que debes hacer tú una sola vez (el cliente de Google)
El plugin necesita un "cliente OAuth" de un proyecto de Google Cloud tuyo. Es gratis. Pasos (de memoria de la documentación de Google; verifícalos al hacerlos):
1. En <https://console.cloud.google.com> crea un proyecto y activa **Google Drive API**.
2. **Pantalla de consentimiento OAuth**: tipo *Externo*, pon el nombre de la app y añade el permiso **`.../auth/drive.appdata`** (es el único; Google lo clasifica como no sensible).
3. **Publica la app en "En producción".** Si se queda en "Pruebas", los tokens de renovación caducan a los **7 días** y todos tendrían que reconectar cada semana.
4. **Credenciales → Crear → ID de cliente de OAuth → tipo "TVs y dispositivos de entrada limitada"**. Te da un id y un secreto.
5. Pégalos en el plugin (Avanzado) o, cuando esté probado, ponlos como valores por defecto en `plugin.js`. Este tipo de secreto no es secreto de verdad (va dentro de apps públicas), pero no lo subas a un repositorio público sin pensarlo.

## Cómo guarda y cómo evita pisar escrituras
Drive no permite "escribe solo si la versión es X". El plugin hace **comprobar, escribir y comprobar de nuevo**:
1. Lee la versión del archivo; si no es la que Kino bajó, es un `conflict`.
2. Sube el archivo **y una etiqueta aleatoria** (`appProperties.w`) en **una sola** petición multipart.
3. Lee la etiqueta de vuelta; si no es la suya, otro aparato escribió en medio: `conflict`, y Kino baja, combina y vuelve a subir.

Queda una ventana de milisegundos en la que dos aparatos que escriban a la vez pueden perder una escritura un momento; Kino la recupera en la siguiente ronda porque cada aparato conserva sus datos. Con un servidor real (o R2) esa ventana no existe.

## Qué se verificó y qué no
**Verificado** (pruebas locales contra la imitación): el flujo de código, los errores (cliente equivocado, permiso quitado, código caducado), la subida y bajada con bytes exactos, el conflicto por versión y por etiqueta, el refresco del token (una sola vez) y la conexión revocada, que la clave de cifrado y los secretos nunca viajen a Drive, y que el manifiesto pase el validador y use solo dos hosts.

**Sin verificar contra Google real** (hay que probarlo con un cliente de verdad):
- Que el permiso `drive.appdata` esté permitido en el flujo de dispositivos (creo que sí; no lo pude confirmar).
- Que `files.update` por *multipart* acepte la etiqueta en `appProperties` y la devuelva igual.
- La pantalla de consentimiento: si dice "app no verificada", cuántos usuarios admite antes de pedir verificación, y si hace falta verificar la marca.
- Cuotas reales de la API de Drive para muchos usuarios en un mismo proyecto.
- Que `kino.fetch` siga bien la respuesta `428` del endpoint de token (la imitación la devuelve igual que Google, según la documentación).

## Páginas
[Inicio](https://apk.comparadorinternet.co/sync-gdrive/) · [Privacidad](https://apk.comparadorinternet.co/sync-gdrive/privacy.html) · [Condiciones](https://apk.comparadorinternet.co/sync-gdrive/terms.html) (su fuente está en `docs/`).
