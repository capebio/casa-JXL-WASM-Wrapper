fn main() {
    for a in std::env::args().skip(1) {
        let d = std::fs::read(&a).unwrap();
        let img = raw_pipeline::dng::decode_bytes(&d).unwrap();
        println!("{}: wb_r={:.3} wb_b={:.3} from_cam={} fm={} cm={} curve_pts={} baseline={:.2}",
            a.rsplit('\\').next().unwrap(), img.wb_r, img.wb_b, img.wb_from_camera,
            img.forward_matrix.is_some(), img.color_matrix.is_some(),
            img.profile_tone_curve.len() / 2, img.baseline_exposure);
        println!("  spp={} {}x{} black={} white={} lin_len={} lin_last={:?} pgtm={} active={:?} orient={} max_code={}",
            img.samples_per_pixel, img.width, img.height, img.black, img.white,
            img.linearization_table.len(), img.linearization_table.last(),
            img.profile_gain_table_map.is_some(), img.active_area, img.orientation,
            img.raw.iter().max().unwrap_or(&0));
    }
}
