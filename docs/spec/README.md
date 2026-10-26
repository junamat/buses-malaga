# Especificación: Buses de Málaga

Esta carpeta contiene la especificación funcional y técnica del proyecto en
documentos Markdown planos. No dependen de ninguna herramienta ni proveedor de
IA concreto: son documentos de referencia que cualquiera puede leer, editar o
alimentar a la herramienta que prefiera.

## Documentos

Se leen en este orden, siguiendo el flujo requisitos → diseño → implementación:

1. [`requirements.md`](./requirements.md) — Requisitos funcionales: qué debe
   hacer el sistema y el comportamiento observable esperado.
2. [`design.md`](./design.md) — Diseño técnico: arquitectura, modelo de datos y
   decisiones que satisfacen los requisitos.
3. [`tasks.md`](./tasks.md) — Plan de implementación: las tareas derivadas del
   diseño.

El contexto arquitectónico de alto nivel (fuentes de datos, stack, despliegue)
vive en [`SPEC.md`](../../SPEC.md) en la raíz del repositorio; los documentos de
esta carpeta lo referencian sin repetirlo.

## Procedencia

Estos documentos se generaron originalmente con el flujo de especificaciones de
Kiro. Se han movido aquí desde `.kiro/specs/` para que formen parte de la
documentación del repositorio y sean útiles con independencia del editor o
asistente que se use.