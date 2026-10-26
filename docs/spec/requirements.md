# Requirements Document

## Introduction

Buses de Málaga es una aplicación web de seguimiento de los autobuses de la EMT de Málaga cuyo objetivo es ampliar funcionalmente la aplicación oficial de la EMT y ofrecer una experiencia más fiable que esta. La aplicación combina posiciones de vehículos en tiempo real (refresco de 1 minuto), datos estáticos GTFS y estimaciones oficiales obtenidas por scraping como baseline de calibración, para presentar al usuario un mapa interactivo con buses, paradas, estimaciones de llegada de mejor esfuerzo, filtros, favoritos y aportaciones por vehículo. Además, expone una API REST que permite construir clientes de terceros.

Este documento cubre los requisitos funcionales del sistema. El contexto técnico (fuentes de datos abiertos del Ayuntamiento de Málaga, arquitectura Next.js en Vercel Hobby, Supabase Postgres + PostGIS, ingesta con `pg_cron` + `pg_net`, mapa Leaflet + OpenStreetMap y la estrategia de estimación propia) está descrito en `SPEC.md` y no se repite aquí; este documento se centra en el comportamiento observable del sistema.

Las funcionalidades relativas a barrios/distritos (Requisito 10) y parte de las aportaciones por vehículo se marcan como opcionales o de fase 2, pero quedan documentadas para delimitar el alcance.

## Glossary

- **Sistema**: La aplicación web Buses de Málaga en su conjunto (frontend, API y capa de datos).
- **Frontend_Mapa**: El componente cliente que renderiza el mapa interactivo con Leaflet y teselas de OpenStreetMap.
- **API_REST**: El conjunto de endpoints HTTP del sistema que exponen datos en formato canónico para consumo propio y de clientes de terceros.
- **Servicio_Ingesta**: El componente que recupera periódicamente las posiciones de autobuses y los datos estáticos y los normaliza en el modelo interno.
- **Estimador_ETA**: El componente que calcula el tiempo estimado de llegada del siguiente autobús a una parada.
- **Servicio_Calibracion**: El componente que obtiene los minutos oficiales de la web móvil de la EMT y los usa como referencia para validar y ajustar el Estimador_ETA.
- **Servicio_Favoritos**: El componente que gestiona el alta, consulta y baja de favoritos de un usuario autenticado.
- **Servicio_Aportaciones**: El componente que gestiona la información aportada por los usuarios sobre un vehículo concreto.
- **Servicio_Autenticacion**: El componente que gestiona la identidad y la sesión del usuario.
- **Bus**: Un vehículo concreto de la EMT, identificado de forma única por `codBus`.
- **Linea**: Una línea de la EMT, identificada por `codLinea` (equivalente a `route_id` del GTFS).
- **Sentido**: La dirección de recorrido de un vehículo o parada dentro de una línea (`sentido`).
- **Parada**: Un punto de parada de la EMT, identificado por `codParada`, con nombre legible y coordenadas.
- **ETA**: Tiempo estimado de llegada (Estimated Time of Arrival), expresado en minutos.
- **GeoJSON_Canonico**: Representación de salida del sistema como `FeatureCollection` con coordenadas numéricas en orden `[lon, lat]`.
- **Minutos_Oficiales**: Los tiempos de espera por parada publicados por la web móvil de la EMT, usados solo como baseline de calibración.
- **Favorito**: Un elemento marcado por un usuario como de interés; puede ser una Parada, una Linea o una combinación Parada+Linea.
- **Usuario_Autenticado**: Un usuario que ha iniciado sesión mediante el Servicio_Autenticacion.

## Requirements

### Requirement 1: Mapa interactivo con capas de OpenStreetMap

**User Story:** Como usuario, quiero un mapa interactivo con capas de OpenStreetMap y un conmutador de capas, para visualizar la ciudad y elegir el estilo de fondo que prefiero.

#### Acceptance Criteria

1. WHEN el usuario abre la aplicación, THE Frontend_Mapa SHALL renderizar un mapa interactivo centrado en el área de servicio de la EMT de Málaga con teselas de OpenStreetMap en un plazo máximo de 3 segundos desde la carga de la aplicación.
2. THE Frontend_Mapa SHALL ofrecer un conmutador de capas que presente al menos 2 capas base de OpenStreetMap seleccionables, de las cuales exactamente una esté activa en todo momento.
3. WHEN el usuario abre la aplicación, THE Frontend_Mapa SHALL establecer un nivel de zoom inicial entre 10 y 16 y marcar como activa una única capa base por defecto.
4. WHEN el usuario selecciona una capa en el conmutador de capas, THE Frontend_Mapa SHALL mostrar la capa seleccionada y ocultar la capa base previamente activa, manteniendo sin cambios el centro y el nivel de zoom actuales del mapa.
5. IF las teselas de la capa seleccionada no se pueden cargar, THEN THE Frontend_Mapa SHALL conservar la capa base previamente activa y mostrar una indicación de error que informe del fallo de carga.
6. THE Frontend_Mapa SHALL permitir las operaciones de desplazamiento (pan) y de acercamiento/alejamiento (zoom) sobre el mapa, restringiendo el zoom a un rango entre 1 (alejamiento máximo) y 19 (acercamiento máximo).

### Requirement 2: Visualización de buses y paradas en el mapa

**User Story:** Como usuario, quiero ver la posición de los autobuses y las paradas en el mapa, con el código de línea y el sentido de cada bus, para seguir el servicio en tiempo real.

#### Acceptance Criteria

1. WHEN existen posiciones de buses disponibles, THE Frontend_Mapa SHALL mostrar cada Bus en su posición geográfica sobre el mapa.
2. WHEN se muestra un Bus en el mapa, THE Frontend_Mapa SHALL mostrar el código de Linea y el Sentido asociados a ese Bus.
3. THE Frontend_Mapa SHALL mostrar las Paradas en sus coordenadas geográficas sobre el mapa.
4. WHEN el usuario selecciona una Parada en el mapa, THE Frontend_Mapa SHALL mostrar el nombre legible de la Parada y su código `codParada`.
5. WHEN se actualizan las posiciones de los buses conforme a la resolución de refresco de 1 minuto definida en el Requisito 12, THE Frontend_Mapa SHALL actualizar las posiciones mostradas con los datos de la captura más reciente disponible.
6. IF no existen posiciones de buses disponibles para el criterio de visualización actual, THEN THE Frontend_Mapa SHALL indicar al usuario que no hay buses que mostrar.
7. IF las posiciones mostradas quedan obsoletas porque un fallo de ingesta (según el Requisito 12) impide su actualización, THEN THE Frontend_Mapa SHALL indicar al usuario la antigüedad de los datos mostrados y su condición de obsoletos.

### Requirement 3: Filtrado de la visualización por línea y otros criterios

**User Story:** Como usuario, quiero filtrar lo que se muestra en el mapa por número de línea y por otros criterios, para centrarme en el servicio que me interesa.

#### Acceptance Criteria

1. WHEN el usuario aplica un filtro por una o varias Lineas, THE Frontend_Mapa SHALL mostrar únicamente los Buses y Paradas cuyo `codLinea` coincide con alguna de las líneas seleccionadas y SHALL ocultar el resto de Buses y Paradas.
2. WHERE el usuario selecciona un filtro por Sentido, THE Frontend_Mapa SHALL mostrar únicamente los Buses cuyo Sentido coincide con el valor seleccionado.
3. WHILE los filtros por Linea y por Sentido están ambos activos, THE Frontend_Mapa SHALL mostrar únicamente los Buses que cumplen simultáneamente ambos criterios (lógica AND).
4. WHEN el usuario elimina todos los filtros activos, THE Frontend_Mapa SHALL volver a mostrar el conjunto de Buses y Paradas que se mostraba conforme al criterio de visualización previo a la aplicación de cualquier filtro.
5. IF la combinación de filtros activos no corresponde a ningún Bus ni Parada, THEN THE Frontend_Mapa SHALL indicar al usuario que no hay resultados para la combinación de filtros activos y SHALL conservar sin cambios el estado de los filtros aplicados.

### Requirement 4: Estimación de llegada del siguiente bus por parada

**User Story:** Como usuario, quiero conocer el tiempo estimado de llegada del siguiente autobús a una parada, para decidir cuándo dirigirme a ella.

#### Acceptance Criteria

1. WHEN el usuario consulta una Parada, THE Estimador_ETA SHALL calcular, para cada Linea que presta servicio en esa Parada, el ETA en minutos del Bus cuya llegada estimada a esa Parada sea la más próxima en el tiempo, considerando únicamente Buses con un ETA estimado no superior a 60 minutos.
2. THE Estimador_ETA SHALL calcular el ETA a partir de la distancia a lo largo del recorrido entre la posición del Bus y la Parada, convertida a tiempo mediante el modelo de estimación del sistema.
3. WHEN el usuario consulta una Parada, THE Estimador_ETA SHALL producir el conjunto de ETA de esa Parada en un plazo máximo de 2 segundos desde la consulta.
4. THE Estimador_ETA SHALL expresar cada ETA con granularidad entera de minutos.
5. WHEN se muestra un ETA al usuario, THE Frontend_Mapa SHALL indicar que el valor es una estimación de mejor esfuerzo.
6. IF la posición más reciente disponible del Bus tiene una antigüedad superior a 120 segundos, THEN THE Estimador_ETA SHALL indicar que el ETA no está disponible para esa combinación de Bus y Parada en lugar de devolver un valor numérico.
7. WHILE el refresco de posiciones tiene una resolución de 1 minuto, THE Estimador_ETA SHALL señalar un margen de estimación de ±1 minuto asociado a dicha resolución.

### Requirement 5: Calibración del estimador con los minutos oficiales de la EMT

**User Story:** Como mantenedor del sistema, quiero calibrar el estimador propio con los minutos oficiales de la EMT, para mejorar la fiabilidad de las estimaciones sin depender de esa fuente en producción.

#### Acceptance Criteria

1. WHEN se cumple el intervalo de muestreo de calibración del Sistema, THE Servicio_Calibracion SHALL obtener por scraping los Minutos_Oficiales por Parada a partir de la web móvil de la EMT para usarlos como baseline de referencia.
2. IF el Servicio_Calibracion recibe un valor de Minutos_Oficiales fuera del rango válido de minutos de espera comprendido entre 0 y 120 minutos (por ejemplo, el valor centinela 785), THEN THE Servicio_Calibracion SHALL descartar ese valor del conjunto de calibración y SHALL registrar el descarte.
3. THE Servicio_Calibracion SHALL utilizar los Minutos_Oficiales para validar y ajustar el modelo del Estimador_ETA.
4. THE Sistema SHALL calcular el ETA expuesto en producción exclusivamente con el Estimador_ETA, sin incluir los Minutos_Oficiales en ninguna respuesta de ETA de producción.
5. IF la web móvil de la EMT no está disponible durante una ejecución de calibración, THEN THE Sistema SHALL mantener sin cambios el ETA calculado por el Estimador_ETA en producción.

### Requirement 6: Paradas más cercanas mediante geolocalización

**User Story:** Como usuario, quiero ver las paradas más cercanas a mi ubicación, para llegar rápidamente a la parada adecuada.

#### Acceptance Criteria

1. WHEN el usuario solicita las paradas más cercanas, THE Frontend_Mapa SHALL solicitar permiso de geolocalización al navegador del usuario.
2. WHEN el usuario concede el permiso de geolocalización, THE Sistema SHALL mostrar como máximo las 10 Paradas más cercanas situadas dentro de un radio de 1000 metros de la ubicación del usuario, ordenadas por distancia ascendente.
3. IF el usuario concede el permiso de geolocalización pero no existe ninguna Parada dentro del radio de 1000 metros, THEN THE Frontend_Mapa SHALL informar al usuario mediante un mensaje de que no hay paradas cercanas a su ubicación.
4. IF el usuario deniega el permiso de geolocalización, THEN THE Frontend_Mapa SHALL informar al usuario mediante un mensaje de que no se puede determinar su ubicación y SHALL mantener disponibles el resto de funcionalidades del mapa.
5. IF el navegador no devuelve la ubicación del usuario en un plazo de 10 segundos tras concederse el permiso, THEN THE Frontend_Mapa SHALL cancelar la solicitud e informar al usuario mediante un mensaje de que no se pudo obtener su ubicación.
6. WHEN se muestra una Parada cercana, THE Frontend_Mapa SHALL mostrar la distancia estimada en metros entre la ubicación del usuario y esa Parada.

### Requirement 7: Autenticación de usuario

**User Story:** Como usuario, quiero iniciar sesión en la aplicación, para conservar mis favoritos y mis aportaciones entre dispositivos y sesiones.

#### Acceptance Criteria

1. WHEN un usuario solicita iniciar sesión con credenciales válidas, THE Servicio_Autenticacion SHALL establecer una sesión autenticada para ese usuario en un plazo máximo de 5 segundos y devolver un identificador de sesión.
2. WHILE una sesión autenticada permanece activa, THE Servicio_Autenticacion SHALL mantenerla válida durante un máximo de 30 días desde el último acceso, tras lo cual SHALL requerir un nuevo inicio de sesión.
3. IF un usuario intenta iniciar sesión con credenciales no válidas, THEN THE Servicio_Autenticacion SHALL rechazar el inicio de sesión, no establecer ninguna sesión y mostrar un mensaje de error indicando que las credenciales son incorrectas.
4. IF un usuario supera 5 intentos de inicio de sesión fallidos consecutivos para la misma identidad, THEN THE Servicio_Autenticacion SHALL bloquear nuevos intentos para esa identidad durante un mínimo de 300 segundos y mostrar un mensaje de error indicando el bloqueo temporal.
5. WHEN un Usuario_Autenticado solicita cerrar sesión, THE Servicio_Autenticacion SHALL finalizar la sesión del usuario e invalidar su identificador de sesión en un plazo máximo de 5 segundos.
6. IF un usuario no autenticado solicita una operación que requiere sesión, THEN THE Sistema SHALL rechazar la ejecución de la operación, conservar los datos introducidos sin modificarlos y requerir que el usuario inicie sesión antes de ejecutar la operación.

### Requirement 8: Gestión de favoritos

**User Story:** Como usuario autenticado, quiero marcar como favoritos paradas, líneas y combinaciones de parada y línea, para acceder rápidamente al servicio que más uso.

#### Acceptance Criteria

1. WHEN un Usuario_Autenticado marca una Parada existente como Favorito, THE Servicio_Favoritos SHALL persistir ese Favorito asociado al identificador del usuario en un plazo máximo de 2 segundos.
2. WHEN un Usuario_Autenticado marca una Linea existente como Favorito, THE Servicio_Favoritos SHALL persistir ese Favorito asociado al identificador del usuario en un plazo máximo de 2 segundos.
3. WHEN un Usuario_Autenticado marca una combinación de Parada y Linea existentes como Favorito, THE Servicio_Favoritos SHALL persistir ese Favorito asociado al identificador del usuario en un plazo máximo de 2 segundos.
4. IF un Usuario_Autenticado intenta marcar como Favorito un elemento (Parada, Linea o combinación) que no existe, THEN THE Servicio_Favoritos SHALL rechazar la operación, no persistir ningún Favorito y devolver un mensaje de error que indique que el elemento no existe.
5. WHEN un Usuario_Autenticado consulta sus favoritos, THE Servicio_Favoritos SHALL devolver todos los Favoritos asociados a ese usuario, hasta un máximo de 500 Favoritos por usuario.
6. WHEN un Usuario_Autenticado consulta sus favoritos y no tiene ningún Favorito asociado, THE Servicio_Favoritos SHALL devolver un conjunto vacío.
7. WHEN un Usuario_Autenticado elimina un Favorito existente, THE Servicio_Favoritos SHALL eliminar ese Favorito del conjunto asociado al usuario y conservar sin cambios el resto de sus Favoritos.
8. IF un Usuario_Autenticado intenta eliminar un Favorito que no figura en su conjunto, THEN THE Servicio_Favoritos SHALL rechazar la operación, no modificar el conjunto de Favoritos del usuario y devolver un mensaje de error que indique que el Favorito no existe.
9. IF un Usuario_Autenticado intenta marcar como Favorito un elemento que ya figura en sus favoritos, THEN THE Servicio_Favoritos SHALL mantener un único registro de ese Favorito para el usuario y no crear un registro duplicado.
10. IF un Usuario_Autenticado intenta marcar un nuevo Favorito cuando ya tiene 500 Favoritos asociados, THEN THE Servicio_Favoritos SHALL rechazar la operación, no persistir el nuevo Favorito y devolver un mensaje de error que indique que se ha alcanzado el límite de favoritos.

### Requirement 9: Aportaciones de información por vehículo

**User Story:** Como usuario autenticado, quiero aportar información sobre un autobús concreto identificado por su código de bus, para compartir el estado real del vehículo con otros usuarios.

#### Acceptance Criteria

1. WHEN un Usuario_Autenticado envía una aportación válida sobre un Bus identificado por `codBus`, THE Servicio_Aportaciones SHALL persistir la aportación asociada a ese `codBus` y al usuario y SHALL devolver una confirmación de registro al usuario.
2. THE Servicio_Aportaciones SHALL ofrecer un conjunto predefinido de como máximo 10 opciones de información seleccionables para describir el estado de un Bus.
3. WHEN un usuario consulta un Bus que tiene aportaciones vigentes registradas, THE Sistema SHALL mostrar la información aportada para ese `codBus`.
4. IF una aportación referencia un `codBus` que no corresponde a ningún vehículo conocido por el Sistema, THEN THE Servicio_Aportaciones SHALL rechazar la aportación e informar del motivo.
5. IF una aportación incluye una opción que no pertenece al conjunto predefinido de opciones, THEN THE Servicio_Aportaciones SHALL rechazar la aportación, no persistir ningún dato y conservar sin cambios las aportaciones ya registradas.
6. THE Servicio_Aportaciones SHALL aplicar una ventana de vigencia de 60 minutos a cada aportación desde su registro y SHALL excluir de la visualización las aportaciones cuya vigencia ha expirado.

### Requirement 10: Capa y filtro de barrios y distritos (opcional / fase 2)

**User Story:** Como usuario, quiero poder ver y filtrar la información por barrios y distritos, para acotar la visualización a una zona concreta de la ciudad.

#### Acceptance Criteria

1. WHERE los datos de barrios y distritos del portal de datos abiertos están integrados en el Sistema, THE Frontend_Mapa SHALL ofrecer una capa seleccionable con los límites de barrios y distritos.
2. WHERE la capa de barrios y distritos está disponible, WHEN el usuario filtra por un barrio o distrito, THE Frontend_Mapa SHALL mostrar únicamente los Buses y Paradas situados dentro del área (polígono) del barrio o distrito seleccionado, incluyendo los situados sobre su límite.
3. WHERE la capa de barrios y distritos está disponible, IF el área seleccionada no contiene ningún Bus ni Parada, THEN THE Frontend_Mapa SHALL informar al usuario de que no hay elementos en esa área y conservar la capa de límites visible.
4. WHERE la capa de barrios y distritos está disponible, WHEN el usuario desactiva el filtro por barrio o distrito, THE Frontend_Mapa SHALL restaurar la visualización conforme al resto de filtros activos.
5. WHERE los datos de barrios y distritos no están integrados en el Sistema, THE Frontend_Mapa SHALL ofrecer el resto de funcionalidades del mapa sin la capa de barrios y distritos.

### Requirement 11: API REST para clientes de terceros

**User Story:** Como desarrollador de un cliente externo, quiero consumir los datos del sistema a través de una API REST, para construir aplicaciones propias sobre los datos de la EMT.

#### Acceptance Criteria

1. THE API_REST SHALL exponer endpoints HTTP para consultar las posiciones de Buses, las Paradas y las Lineas.
2. THE API_REST SHALL exponer un endpoint HTTP para consultar el ETA del siguiente Bus de una Parada indicada.
3. WHEN un cliente solicita un listado de Buses, Paradas o Lineas a la API_REST, THE API_REST SHALL devolver como máximo 200 elementos por página e incluir en la respuesta la información necesaria para solicitar la página siguiente.
4. WHEN un cliente realiza una petición válida a la API_REST, THE API_REST SHALL devolver la respuesta en un plazo máximo de 2 segundos.
5. WHEN un cliente solicita datos geográficos a la API_REST, THE API_REST SHALL devolver la respuesta en formato GeoJSON_Canonico.
6. IF un cliente solicita el ETA de una Parada para la que no existe ningún ETA disponible, THEN THE API_REST SHALL responder con éxito e indicar en el cuerpo de la respuesta que el ETA no está disponible, de forma coherente con el Requisito 4.
7. IF un cliente solicita un recurso inexistente, THEN THE API_REST SHALL responder indicando que el recurso no se ha encontrado.
8. IF una petición a la API_REST es sintácticamente incorrecta, THEN THE API_REST SHALL responder con un error de cliente y un cuerpo de respuesta que indique que la petición es incorrecta.
9. IF una petición a la API_REST omite uno o más parámetros obligatorios, THEN THE API_REST SHALL responder con un error de cliente y un cuerpo de respuesta que identifique los parámetros obligatorios ausentes.

### Requirement 12: Ingesta y actualización de datos

**User Story:** Como mantenedor del sistema, quiero que las posiciones en tiempo real y los datos estáticos se ingieran y actualicen periódicamente, para que la información mostrada se mantenga vigente.

#### Acceptance Criteria

1. WHEN transcurren 60 segundos desde la ejecución anterior de ingesta de posiciones, THE Servicio_Ingesta SHALL recuperar las posiciones de Buses y almacenarlas en el modelo interno.
2. WHEN transcurren 24 horas desde la recarga anterior de datos estáticos, THE Servicio_Ingesta SHALL recargar los datos estáticos GTFS en el modelo interno.
3. WHEN el Servicio_Ingesta normaliza los datos de origen, THE Servicio_Ingesta SHALL convertir las coordenadas a valores numéricos en orden `[lon, lat]`.
4. IF una fuente de datos no responde en un plazo de 30 segundos durante una ejecución de ingesta, THEN THE Servicio_Ingesta SHALL considerar esa fuente no disponible para la ejecución y SHALL conservar sin modificación los datos previamente ingeridos.
5. IF una fuente de datos no está disponible durante una ejecución de ingesta, THEN THE Servicio_Ingesta SHALL registrar el fallo de la ejecución indicando la fuente de datos afectada.
6. WHEN transcurren 60 segundos desde la ejecución anterior de purga, THE Servicio_Ingesta SHALL eliminar las posiciones crudas de Buses con una antigüedad superior a la ventana de retención de 21600 segundos del Sistema.
