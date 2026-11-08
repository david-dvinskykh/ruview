# RuView Home 3D card

Lovelace card that builds a 3D model of the home from a Dreame vacuum map
(`dreame_vacuum` integration, `/api/camera_map_data_proxy/<camera>`: wall
loops, doors, rooms, furniture, robot, dock) and overlays live state:
RuView sensing nodes coloured by presence/motion and pets tracked by Bermuda.

Install: copy `ruview-home-3d-card.js` to `/config/www/ruview3d/`, put
three.js r160 `three.module.min.js` and `OrbitControls.js` (with its `three`
import pointed at `./three.module.min.js`) in `/config/www/ruview3d/vendor/`,
and add `/local/ruview3d/ruview-home-3d-card.js` as a module resource.

```yaml
type: custom:ruview-home-3d-card
camera: camera.l20_ultra_complete_map
rooms:            # Dreame room id -> HA area name (labels and pet placement)
  2: Кухня
nodes:            # RuView node id and its position in Dreame map millimetres
  - { id: 1, name: esp-32-0, x: -1600, y: -1080, z: 1500 }
pets:
  - { name: Маруся, tracker: device_tracker.x_bermuda_tracker, area: sensor.x_area }
```

Node positions in map millimetres also feed the sensing server
(`node_positions` in metres) so both share one coordinate frame.
