# Kino Sync (experimental)

[Read in English](README.md)

Un **proveedor de sync de Kino** que guarda la copia cifrada en el **Drive de la propia persona**, sin servidor tuyo, sin hojas de cálculo que copiar y sin tokens que pegar: la persona toca **Conectar con Google**, escribe un código en `google.com/device` y listo (el mismo trámite que las apps de TV).

Es un experimento. No es parte de Kino ni está recomendado. No es oficial: sin relación con Google.

```
tu celular ─┐                                           ┌─ Drive de la persona
            ├─ plugin ─ https ─▶ oauth2.googleapis.com  │   carpeta "Kino Sync":
tu TV   ────┘                    www.googleapis.com ────┘    kino-sync.bin, cifrado
```

## Qué ve la persona
1. **Conectar con Google** → el plugin muestra un código (por ejemplo `ABCD-EFGH`).
2. En otro aparato abre `google.com/device`, escribe el código, elige su cuenta y acepta.
3. Vuelve y toca **Ya lo hice**. Cada aparato se conecta por su cuenta; la copia es la misma para todos.

La clave de cifrado la crea Kino sola (`generateKey`) y viaja entre aparatos con **Enviar / Recibir configuración**; **Google nunca la recibe**, solo ve el archivo cifrado. (En el desktop esa función todavía no existe: ahí la clave tendría que ponerse a mano.)

## Dónde queda la copia
En una **carpeta "Kino Sync" del Drive de la persona**, con un solo archivo, `kino-sync.bin`. El permiso es `drive.file`: el plugin solo ve los archivos que **él** creó, nunca el resto del Drive. (La carpeta oculta de la app, `drive.appdata`, habría sido mejor, pero Google la rechaza en este tipo de inicio de sesión: ver "Verificado".)

**Desconectar** solo hace que *este aparato* olvide su conexión. No revoca el token en Google, porque revocar el token de un aparato también mató el del otro (medido), así que revocar desconectaría a todos. Para quitar el acceso en todos, la persona va a `myaccount.google.com/permissions`.

## Lo que debes hacer tú una sola vez (el cliente de Google)
El plugin necesita un "cliente OAuth" de un proyecto de Google Cloud tuyo. Es gratis.
1. En <https://console.cloud.google.com> crea un proyecto y activa **Google Drive API**.
2. **Branding**: nombre de la app exactamente **`Kino Sync`** (tiene que coincidir con el de la página principal), los enlaces de página principal, privacidad y condiciones (ver "Páginas"), un logo, y el dominio de esos enlaces como dominio autorizado (verificado en Google Search Console).
3. **Acceso a los datos**: añade solo el permiso **`.../auth/drive.file`** (no sensible: no pide verificación del permiso).
4. **Publica la app en "En producción".** Si se queda en "Pruebas", los tokens de renovación caducan a los **7 días**.
5. **Clientes → Crear → ID de cliente de OAuth → tipo "Televisores y dispositivos de entrada limitada"**. Te da un id y un secreto.
6. Pégalos en el plugin (Avanzado) o, cuando esté probado, ponlos como valores por defecto en `plugin.js`. Este tipo de secreto no es secreto de verdad (va dentro de apps públicas), pero no lo subas a un repositorio público sin pensarlo.

## Cómo guarda y cómo evita pisar escrituras
Drive no permite "escribe solo si la versión es X". El plugin hace **comprobar, escribir y comprobar de nuevo**:
1. Lee la versión del archivo; si no es la que Kino bajó, es un `conflict`.
2. Sube el archivo **y una etiqueta aleatoria** (`appProperties.w`) en **una sola** petición multipart.
3. Lee la etiqueta de vuelta; si no es la suya, otro aparato escribió en medio: `conflict`, y Kino baja, combina y vuelve a subir.

Queda una ventana de milisegundos en la que dos aparatos que escriban a la vez pueden perder una escritura un momento; Kino la recupera en la siguiente ronda porque cada aparato conserva sus datos. Con un servidor real (o R2) esa ventana no existe.

## Verificado y sin verificar
**Verificado contra el Google real (2026-10-31)**, con el código del propio plugin:
- El flujo de código da un código con `drive.file` y **rechaza `drive.appdata`** (`invalid_scope: Invalid device flow scope`).
- El intercambio del token, la creación de la carpeta "Kino Sync" y del archivo funcionan, y la bajada devuelve **bytes idénticos** (100 KB y 3 MB).
- Una subida con una versión vieja se rechaza (`conflict`); solo se hace una carpeta.
- Un **segundo aparato con su propio inicio de sesión** ve la copia que subió el primero.
- Revocar el token de un aparato invalidó el del otro, así que Desconectar nunca revoca.

**Sin verificar** (hace falta gente, tiempo o una pantalla de consentimiento real): cómo se ve la pantalla de consentimiento y si Google pide verificar la marca; las cuotas de la API de Drive con muchos usuarios en un proyecto; cuánto duran los tokens en producción; la respuesta `authorization_pending` del sondeo (contra Google solo se corrió el camino ya aprobado); qué responde Google si la persona desmarca el permiso (la comprobación está en el código y las pruebas, no se vio en vivo); la respuesta de "Drive lleno".

## Páginas
La página principal, la política de privacidad y las condiciones del servicio a las que enlaza la pantalla de consentimiento están en `docs/`.

## Páginas
[Inicio](https://apk.comparadorinternet.co/sync-gdrive/) · [Privacidad](https://apk.comparadorinternet.co/sync-gdrive/privacy.html) · [Condiciones](https://apk.comparadorinternet.co/sync-gdrive/terms.html) (su fuente está en `docs/`).
