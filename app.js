// 1. CONFIGURATION
// Note: No API Key needed!
const routeLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snow_Plowing_Routes_2026_WFL1/FeatureServer/0"; 
const breadcrumbLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snowplow_Breadcrumbs/FeatureServer/0"; 

// Initialize Map
const map = L.map('map', { zoomControl: false }).setView([39.7732, -77.7242], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// Controls
L.control.zoom({ position: 'topleft' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: true, metric: false }).addTo(map);

// --- STATE VARIABLES ---
let allRouteData = []; 
let currentOperator = "";
let currentTruck = "";
let watchId = null;
let lastKnownLocation = null;
let isPlowing = false; 
let isFollowing = false; 

// AUTO-STOP VARIABLES
let lastMovementTime = Date.now(); // When was the last time we moved?
const STATIONARY_TIMEOUT = 5 * 60 * 1000; // 5 Minutes (in milliseconds)
const MOVE_THRESHOLD = 0.0002; // Roughly 20 meters in degrees

// --- LAYERS ---
const routeLayer = L.esri.featureLayer({
  url: routeLayerUrl,
  style: { color: 'red', weight: 4 }, 
  onEachFeature: function(feature, layer) {
    layer.on('click', function(e) {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      
      let popupContent = "<b>Route Attributes:</b><br><hr style='margin: 5px 0;'>";
      for (const key in feature.properties) {
          const value = feature.properties[key];
          if(value !== null && key !== "GlobalID" && key !== "Shape__Length" && key !== "OBJECTID") {
             popupContent += `<b>${key}:</b> ${value}<br>`;
          }
      }
      popupContent += `<br><a href="${googleMapsUrl}" target="_blank" style="background:green; color:white; padding:5px; display:block; text-align:center; text-decoration:none;">Navigate Here</a>`;
      layer.bindPopup(popupContent).openPopup();
    });
  }
});

const breadcrumbLayer = L.esri.featureLayer({
    url: breadcrumbLayerUrl,
    pointToLayer: function (geojson, latlng) {
        return L.circleMarker(latlng, { color: 'blue', radius: 4, fillOpacity: 0.5 });
    }
});

// --- DROPDOWNS ---
routeLayer.query().where("1=1").run(function(error, featureCollection){
    if (error) { console.error(error); return; }
    featureCollection.features.forEach(f => {
        allRouteData.push({ operator: f.properties.Operator, truck: f.properties.Truck_Num });
    });
    updateDropdowns(null);
});

function updateDropdowns(changedBy) {
    const opSelect = document.getElementById("operatorInput");
    const truckSelect = document.getElementById("truckInput");
    const selectedOp = opSelect.value;
    const selectedTruck = truckSelect.value;

    let filteredData = allRouteData.filter(item => {
        let matchOp = (selectedOp === "") || (item.operator === selectedOp);
        let matchTruck = (selectedTruck === "") || (item.truck == selectedTruck); 
        return matchOp && matchTruck;
    });
    if (filteredData.length === 0) filteredData = allRouteData;

    const availableOps = new Set(filteredData.map(i => i.operator).filter(x => x));
    const availableTrucks = new Set(filteredData.map(i => i.truck).filter(x => x));

    if (changedBy !== "operator") {
        opSelect.innerHTML = '<option value="">-- Select Name --</option>';
        Array.from(availableOps).sort().forEach(name => {
            let opt = document.createElement("option");
            opt.value = name; opt.innerText = name;
            if (name === selectedOp) opt.selected = true; 
            opSelect.appendChild(opt);
        });
    }
    if (changedBy !== "truck") {
        truckSelect.innerHTML = '<option value="">-- Select Truck --</option>';
        Array.from(availableTrucks).sort((a,b)=>a-b).forEach(num => {
            let opt = document.createElement("option");
            opt.value = num; opt.innerText = "Truck " + num;
            if (num == selectedTruck) opt.selected = true; 
            truckSelect.appendChild(opt);
        });
    }
}
document.getElementById("operatorInput").addEventListener("change", () => updateDropdowns("operator"));
document.getElementById("truckInput").addEventListener("change", () => updateDropdowns("truck"));


// --- MAIN FUNCTIONS ---
function startShift() {
  currentOperator = document.getElementById('operatorInput').value;
  currentTruck = document.getElementById('truckInput').value;

  if(!currentOperator && !currentTruck) {
    alert("Please select an Operator Name OR a Truck Number.");
    return;
  }

  document.getElementById('panel').style.display = 'none';
  document.getElementById('plowControlBar').style.display = 'block'; 
  
  const label = document.getElementById('activeOperatorLabel');
  label.style.display = 'block';
  let labelText = "Viewing Route";
  if(currentOperator) labelText += ` for: ${currentOperator}`;
  if(currentTruck) labelText += ` — Truck ${currentTruck}`;
  label.innerText = labelText;

  let sqlParts = [];
  if (currentOperator) sqlParts.push(`Operator = '${currentOperator}'`);
  if (currentTruck) sqlParts.push(`Truck_Num = ${currentTruck}`);
  const finalWhere = sqlParts.join(" OR ");
  
  routeLayer.setWhere(finalWhere);
  routeLayer.addTo(map);
  routeLayer.query().where(finalWhere).bounds(function(error, latLngBounds){
    if(!error && latLngBounds) map.fitBounds(latLngBounds);
  });

  loadTodaysBreadcrumbs();
  startTracking();
}

function togglePlowing() {
    const btn = document.getElementById('plowBtn');
    
    if (isPlowing) {
        // TURN OFF
        isPlowing = false;
        btn.innerHTML = "START PLOWING (Recording Off)";
        btn.style.backgroundColor = "#555"; 
        btn.style.boxShadow = "none";
    } else {
        // TURN ON
        isPlowing = true;
        // Reset the "Auto-Stop" timer so it doesn't shut off instantly
        lastMovementTime = Date.now(); 
        btn.innerHTML = "STOP PLOWING (Recording ON)";
        btn.style.backgroundColor = "#28a745"; 
        btn.style.boxShadow = "0 0 10px #28a745";
    }
}

// --- GPS LOGIC ---
function startTracking() {
  if (!navigator.geolocation) { alert("Geolocation not supported"); return; }
  watchId = navigator.geolocation.watchPosition(success, error, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 5000
  });
}

function success(position) {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  
  // 1. CHECK FOR STATIONARY (AUTO-STOP LOGIC)
  if (isPlowing && lastKnownLocation) {
      // Calculate simple distance difference
      const diffLat = Math.abs(lat - lastKnownLocation[0]);
      const diffLng = Math.abs(lng - lastKnownLocation[1]);
      
      // If moved more than threshold, reset timer
      if (diffLat > MOVE_THRESHOLD || diffLng > MOVE_THRESHOLD) {
          lastMovementTime = Date.now();
      } else {
          // Has it been 5 minutes since we last moved?
          if (Date.now() - lastMovementTime > STATIONARY_TIMEOUT) {
              togglePlowing(); // Turn it OFF automatically
              alert("Plowing paused due to inactivity (5 mins stationary).");
          }
      }
  }

  lastKnownLocation = [lat, lng];
  document.getElementById("connectionStatus").innerText = "GPS Signal: Good";

  // 2. UPDATE ICON
  if (!window.myLocationMarker) {
    const plowIcon = L.divIcon({
        className: 'custom-div-icon',
        html: "<div style='font-size:30px;'>🚜</div>",
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
    window.myLocationMarker = L.marker([lat, lng], { icon: plowIcon }).addTo(map);
  } else {
    window.myLocationMarker.setLatLng([lat, lng]);
  }

  // 3. AUTO-FOLLOW
  if (isFollowing) map.setView([lat, lng], 17);

  // 4. UPLOAD DATA (Only if Plowing is ON)
  if (isPlowing) {
      const feature = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          Truck_Num: parseInt(currentTruck) || 0,
          Operator: currentOperator,
          Timestamp: new Date().getTime()
        }
      };

      L.esri.request(breadcrumbLayerUrl + "/addFeatures", { features: [feature] }, function(error, response){
          if(error) {
              console.log("Upload Error: " + error);
          } else {
              // Draw dot locally for instant feedback
              L.circleMarker([lat, lng], { color: 'blue', radius: 4, fillOpacity: 0.5 }).addTo(map);
          }
      });
  }
}

function error() { document.getElementById("connectionStatus").innerText = "GPS Signal: LOST"; }

map.on('dragstart', function() { isFollowing = false; });

function loadTodaysBreadcrumbs() {
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    let whereClause = `Timestamp > ${yesterday.getTime()}`;
    if (currentTruck) whereClause += ` AND Truck_Num = ${currentTruck}`;
    breadcrumbLayer.setWhere(whereClause);
    breadcrumbLayer.addTo(map);
}

// Controls
L.Control.Home = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🏠";
        btn.onclick = function() { location.reload(); }; 
        return btn;
    }
});
new L.Control.Home({ position: 'topleft' }).addTo(map);

L.Control.Locate = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🎯";
        btn.onclick = function() {
            if(lastKnownLocation) { isFollowing = true; map.setView(lastKnownLocation, 17); }
            else { alert("Waiting for GPS..."); }
        };
        return btn;
    }
});
new L.Control.Locate({ position: 'topleft' }).addTo(map);

L.Control.Legend = L.Control.extend({
    onAdd: function(map) {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('a', 'custom-map-btn', container);
        btn.innerHTML = "📝"; btn.href = "#";
        btn.style.width = "30px"; btn.style.height = "30px"; btn.style.display = "block";
        
        const legendBox = L.DomUtil.create('div', '', container);
        legendBox.style.display = 'none'; legendBox.style.backgroundColor = 'white'; legendBox.style.padding = '10px'; legendBox.style.minWidth = '150px'; legendBox.style.position = 'absolute'; legendBox.style.top = '0px'; legendBox.style.left = '35px'; legendBox.style.border = '2px solid rgba(0,0,0,0.2)';

        legendBox.innerHTML = `<strong>Map Legend</strong><br><br><div style="display:flex; align-items:center; margin-bottom:5px;"><div style="width:20px; height:4px; background:red; margin-right:8px;"></div><span>Routes</span></div><div style="display:flex; align-items:center; margin-bottom:5px;"><div style="width:10px; height:10px; background:blue; border-radius:50%; margin-right:8px;"></div><span>Work Done</span></div>`;

        btn.onclick = function(e) { e.preventDefault(); legendBox.style.display = (legendBox.style.display === 'none') ? 'block' : 'none'; };
        return container;
    }
});
new L.Control.Legend({ position: 'topleft' }).addTo(map);


