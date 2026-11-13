/**
 * Certificado intermedio que le falta a la cadena TLS de la API Navega.
 *
 * `navega.emtmalaga.es` solo envía su certificado hoja (`*.emtmalaga.es`) y
 * omite el intermedio `GeoTrust TLS RSA CA G1`. Los navegadores lo descargan
 * solos (AIA), pero Node no: sin él, la conexión falla con
 * `unable to get local issuer certificate`. Ver `docs/api-navega.md`.
 *
 * Se incluye aquí como constante (y no como fichero leído en tiempo de
 * ejecución ni vía `NODE_EXTRA_CA_CERTS`) para que la ingesta funcione sin
 * configuración externa y sobreviva al empaquetado de Next. **No** se desactiva
 * la verificación TLS: `NodeFetchTransport` añade este certificado a las raíces
 * de Node únicamente para las peticiones a {@link HOST_NAVEGA}.
 *
 * Es un certificado público de DigiCert, emitido por `DigiCert Global Root G2`
 * (raíz ya presente en Node). Origen:
 * `http://cacerts.geotrust.com/GeoTrustTLSRSACAG1.crt`.
 *
 * - Huella SHA-256:
 *   `C0:6E:30:7F:7C:FC:1D:32:FA:72:A4:C0:33:C8:7B:90:01:9A:F2:16:F0:77:5D:64:97:8A:2E:CA:6C:8A:23:0E`
 * - **Caduca el 2027-11-02.** Si para entonces la EMT sigue sin enviar la
 *   cadena completa, hay que sustituirlo por el intermedio que firme su nuevo
 *   certificado; el síntoma será el mismo error TLS en `ingest_log`.
 */

/** Host de la API Navega, el único al que se aplica el certificado extra. */
export const HOST_NAVEGA = "navega.emtmalaga.es";

/** `GeoTrust TLS RSA CA G1` en PEM. */
export const CA_INTERMEDIA_NAVEGA = `-----BEGIN CERTIFICATE-----
MIIEjTCCA3WgAwIBAgIQDQd4KhM/xvmlcpbhMf/ReTANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0xNzExMDIxMjIzMzdaFw0yNzExMDIxMjIzMzdaMGAxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xHzAdBgNVBAMTFkdlb1RydXN0IFRMUyBSU0EgQ0EgRzEwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC+F+jsvikKy/65LWEx/TMkCDIuWegh1Ngwvm4Q
yISgP7oU5d79eoySG3vOhC3w/3jEMuipoH1fBtp7m0tTpsYbAhch4XA7rfuD6whU
gajeErLVxoiWMPkC/DnUvbgi74BJmdBiuGHQSd7LwsuXpTEGG9fYXcbTVN5SATYq
DfbexbYxTMwVJWoVb6lrBEgM3gBBqiiAiy800xu1Nq07JdCIQkBsNpFtZbIZhsDS
fzlGWP4wEmBQ3O67c+ZXkFr2DcrXBEtHam80Gp2SNhou2U5U7UesDL/xgLK6/0d7
6TnEVMSUVJkZ8VeZr+IUIlvoLrtjLbqugb0T3OYXW+CQU0kBAgMBAAGjggFAMIIB
PDAdBgNVHQ4EFgQUlE/UXYvkpOKmgP792PkA76O+AlcwHwYDVR0jBBgwFoAUTiJU
IBiV5uNu5g/6+rkS7QYXjzkwDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQWMBQGCCsG
AQUFBwMBBggrBgEFBQcDAjASBgNVHRMBAf8ECDAGAQH/AgEAMDQGCCsGAQUFBwEB
BCgwJjAkBggrBgEFBQcwAYYYaHR0cDovL29jc3AuZGlnaWNlcnQuY29tMEIGA1Ud
HwQ7MDkwN6A1oDOGMWh0dHA6Ly9jcmwzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEds
b2JhbFJvb3RHMi5jcmwwPQYDVR0gBDYwNDAyBgRVHSAAMCowKAYIKwYBBQUHAgEW
HGh0dHBzOi8vd3d3LmRpZ2ljZXJ0LmNvbS9DUFMwDQYJKoZIhvcNAQELBQADggEB
AIIcBDqC6cWpyGUSXAjjAcYwsK4iiGF7KweG97i1RJz1kwZhRoo6orU1JtBYnjzB
c4+/sXmnHJk3mlPyL1xuIAt9sMeC7+vreRIF5wFBC0MCN5sbHwhNN1JzKbifNeP5
ozpZdQFmkCo+neBiKR6HqIA+LMTMCMMuv2khGGuPHmtDze4GmEGZtYLyF8EQpa5Y
jPuV6k2Cr/N3XxFpT3hRpt/3usU/Zb9wfKPtWpoznZ4/44c1p9rzFcZYrWkj3A+7
TNBJE0GmP2fhXhP1D/XVfIW/h0yCJGEiV9Glm/uGOa3DXHlmbAcxSyCRraG+ZBkA
7h4SeM6Y8l/7MBRpPCz6l8Y=
-----END CERTIFICATE-----
`;
