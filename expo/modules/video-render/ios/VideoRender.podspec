Pod::Spec.new do |s|
  s.name           = 'VideoRender'
  s.version        = '1.0.0'
  s.summary        = 'On-device rendering of an edit (clips + overlays) into one mp4'
  s.description    = 'Builds an AVMutableComposition from clip ranges with hard cuts and 20 ms audio seams, draws overlays with Core Animation and exports H.264 mp4.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'QuartzCore', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
