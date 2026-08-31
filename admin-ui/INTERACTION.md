# Admin dashboard interaction blueprint

```yaml
pageArchetype: dashboard
primaryTask: monitor Beacon health and baseline capabilities
surface: internal-tool
platform: responsive
density: standard
designVariance: 3
motionIntensity: 2
regions:
  - persistent product navigation and service status
  - runtime entity summary
  - processing outcome and recent failure summary
  - baseline skill inventory and search
navigationModel: anchored rail on desktop, horizontal section navigation on mobile
actionHierarchy:
  primary: refresh the current read-only snapshot
  secondary: filter the reporting window and search skills
states:
  - idle
  - hover
  - focus
  - active
  - selected
  - disabled
  - loading
  - empty
  - error
  - success
responsiveBehavior:
  desktop: fixed 224px navigation rail and one fluid work column
  tablet: compact rail and two-column metric grid
  mobile: product header, horizontal section navigation, single-column regions
accessibility:
  keyboard: required
  visibleFocus: required
  reducedMotion: required
```

All information is read-only and derived from Beacon's NanoClaw central and session databases plus the shared skill directory. The dashboard stores no operational state.
